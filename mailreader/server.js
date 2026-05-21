const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const pLimit = require('p-limit');
const path = require('path');

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> SessionData

class SessionData {
  constructor() {
    this.sessionId = uuidv4();
    this.accounts = [];               // [{ email, refreshToken, clientId, accessToken, expiresAt, expired }]
    this.sseResponse = null;          // active SSE response object
    this.pollTimer = null;            // setInterval handle
    this.lastPollTime = null;         // timestamp
    this.lastActivity = Date.now();   // used for 30-min cleanup
    this.isPolling = false;
    this.lastReceivedDates = {};      // account email -> latest receivedDateTime seen
    this.seenMessageIds = new Set();  // dedup across all accounts
  }

  markActive() {
    this.lastActivity = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Session cleanup – every 5 minutes
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > TIMEOUT_MS) {
      cleanupSession(session);
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

function cleanupSession(session) {
  if (session.pollTimer) {
    clearInterval(session.pollTimer);
    session.pollTimer = null;
  }
  if (session.sseResponse) {
    try {
      session.sseResponse.end();
    } catch (_) { /* ignore */ }
    session.sseResponse = null;
  }
}

// ---------------------------------------------------------------------------
// OAuth2 token refresh
// ---------------------------------------------------------------------------
async function refreshAccessToken(account) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    client_id: account.clientId,
    scope: 'https://graph.microsoft.com/Mail.Read offline_access',
  });

  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  account.accessToken = data.access_token;
  // Some refreshes don't return a new refresh_token – keep the old one
  if (data.refresh_token) {
    account.refreshToken = data.refresh_token;
  }
  // Token typically valid for 1 hour, but we'll refresh every poll anyway
  account.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  account.expired = false;
}

// ---------------------------------------------------------------------------
// Fetch emails for a single account
// ---------------------------------------------------------------------------
async function fetchEmails(account, session) {
  // Always refresh token before fetching (simple and reliable)
  try {
    await refreshAccessToken(account);
  } catch (err) {
    account.expired = true;
    pushEvent(session, {
      type: 'error',
      account: account.email,
      message: `Token expired / refresh failed: ${err.message}`,
    });
    return [];
  }

  const lastDate = session.lastReceivedDates[account.email];
  
    // On subsequent polls, only fetch emails newer than the last one seen
    let url = 'https://graph.microsoft.com/v1.0/me/messages' +
      '?$select=id,subject,from,receivedDateTime,bodyPreview,isRead' +
      '&$orderby=receivedDateTime desc' +
      '&$top=20';
    if (lastDate) {
      url += `&$filter=receivedDateTime gt ${encodeURIComponent(lastDate)}`;
    }
  
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
      },
    });
  
    if (!res.ok) {
      const text = await res.text();
      pushEvent(session, {
        type: 'error',
        account: account.email,
        message: `Graph API error (${res.status}): ${text.substring(0, 200)}`,
      });
      return [];
    }
  
    const data = await res.json();
    const messages = data.value || [];
  
    const newEmails = [];
    for (const msg of messages) {
      // Dedup by message id (belt-and-suspenders with the $filter above)
      if (session.seenMessageIds.has(msg.id)) {
        continue;
      }
      session.seenMessageIds.add(msg.id);
  
      // Track the newest receivedDateTime seen for this account
      if (!lastDate || msg.receivedDateTime > lastDate) {
        session.lastReceivedDates[account.email] = msg.receivedDateTime;
      }
  
      const fromAddr = msg.from && msg.from.emailAddress
        ? msg.from.emailAddress.address
        : 'unknown@unknown.com';
  
      newEmails.push({
        account: account.email,
        id: msg.id,
        subject: msg.subject || '(no subject)',
        from: fromAddr,
        receivedAt: msg.receivedDateTime,
        preview: (msg.bodyPreview || '').substring(0, 200),
        isRead: msg.isRead || false,
        isNew: true,
      });
    }
  
    return newEmails;
}

// ---------------------------------------------------------------------------
// Full poll cycle for a session
// ---------------------------------------------------------------------------
async function runPollCycle(session) {
  if (session.isPolling) return;
  session.isPolling = true;
  session.markActive();

  const accounts = session.accounts;
  if (accounts.length === 0) {
    session.isPolling = false;
    session.lastPollTime = new Date().toISOString();
    return;
  }

  pushEvent(session, { type: 'status', message: `Fetching ${accounts.length} accounts…` });

  const limit = pLimit(10);
  const tasks = accounts.map(acc =>
    limit(() => fetchEmails(acc, session).catch(err => {
      pushEvent(session, {
        type: 'error',
        account: acc.email,
        message: `Network error: ${err.message}`,
      });
      return [];
    }))
  );

  const results = await Promise.all(tasks);
  const allEmails = results.flat();

  // Sort newest first
  allEmails.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

  if (allEmails.length > 0) {
    pushEvent(session, { type: 'emails', emails: allEmails });
  }

  pushEvent(session, { type: 'status', message: `Loaded ${allEmails.length} new email(s)` });
  session.lastPollTime = new Date().toISOString();
  session.isPolling = false;
}

// ---------------------------------------------------------------------------
// SSE push helper
// ---------------------------------------------------------------------------
function pushEvent(session, data) {
  if (!session.sseResponse) return;
  try {
    session.sseResponse.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    // Client disconnected
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Create session
app.post('/session', (req, res) => {
  const session = new SessionData();
  sessions.set(session.sessionId, session);
  res.json({ sessionId: session.sessionId });
});

// Submit accounts
app.post('/session/:sessionId/accounts', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  const raw = (req.body.accounts || '').trim();
  if (!raw) return res.status(400).json({ error: 'No accounts provided' });

  const lines = raw.split('\n').filter(l => l.trim());
  const parsed = [];

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const email = parts[0].trim();
    const refreshToken = parts[2].trim();
    const clientId = parts[3].trim();
    if (email && refreshToken && clientId) {
      parsed.push({
        email,
        refreshToken,
        clientId,
        accessToken: null,
        expiresAt: 0,
        expired: false,
      });
    }
  }

  if (parsed.length === 0) {
    return res.status(400).json({ error: 'No valid account lines found' });
  }

  session.accounts = parsed;
  res.json({ count: parsed.length });

  // Start polling if SSE is already connected
  if (session.sseResponse) {
    // Clear existing poll timer
    if (session.pollTimer) clearInterval(session.pollTimer);
    // First fetch immediately
    runPollCycle(session);
    // Then poll every 30s
    session.pollTimer = setInterval(() => runPollCycle(session), 30_000);
  }
});

// SSE stream
app.get('/stream/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Keep-alive every 15s
  const keepAlive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 15_000);

  session.sseResponse = res;

  // If accounts already exist, start polling
  if (session.accounts.length > 0 && !session.pollTimer) {
    runPollCycle(session);
    session.pollTimer = setInterval(() => runPollCycle(session), 30_000);
  }

  req.on('close', () => {
    clearInterval(keepAlive);
    session.sseResponse = null;
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = null;
    }
  });
});

// Delete session
app.delete('/session/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  cleanupSession(session);
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`MailReader running on port ${PORT}`);
});