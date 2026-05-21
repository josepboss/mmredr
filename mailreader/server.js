const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const pLimit = require('p-limit');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
const PORT = 9320;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> SessionData

class SessionData {
  constructor() {
    this.sessionId = uuidv4();
    this.accounts = [];               // [{ email, password, refreshToken, clientId, accessToken, expiresAt, expired, lastError }]
    this.sseResponse = null;          // active SSE response object
    this.pollTimer = null;            // setInterval handle
    this.lastPollTime = null;         // timestamp
    this.lastActivity = Date.now();   // used for 60-min cleanup
    this.isPolling = false;
    this.pollCycleDuration = 0;       // ms — tracks how long the last poll cycle took
    this.lastReceivedDates = {};      // account email -> latest receivedDateTime seen
    this.seenMessageIds = new Set();  // dedup across all accounts
    // Temporary XLSX data during column preview flow
    this.xlsxPreviewData = null;      // { rows: [], detectedCols: {} }
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
  const TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
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
// Token refresh
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
  if (data.refresh_token) {
    account.refreshToken = data.refresh_token;
  }
  account.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  account.expired = false;
  account.lastError = null;
}

// ---------------------------------------------------------------------------
// Fetch emails for a single account
// ---------------------------------------------------------------------------
async function fetchEmails(account, session) {
  try {
    await refreshAccessToken(account);
  } catch (err) {
    account.expired = true;
    account.lastError = err.message.substring(0, 200);
    return [];
  }

  const lastDate = session.lastReceivedDates[account.email];
  let url = 'https://graph.microsoft.com/v1.0/me/messages' +
    '?$select=id,subject,from,receivedDateTime,bodyPreview,isRead' +
    '&$orderby=receivedDateTime desc' +
    '&$top=20';
  if (lastDate) {
    url += `&$filter=receivedDateTime gt ${encodeURIComponent(lastDate)}`;
  }

  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });

  // Handle rate limiting with Retry-After
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
  }

  if (!res.ok) {
    const text = await res.text();
    account.expired = true;
    account.lastError = `Graph API error (${res.status}): ${text.substring(0, 200)}`;
    return [];
  }

  const data = await res.json();
  const messages = data.value || [];

  const newEmails = [];
  for (const msg of messages) {
    if (session.seenMessageIds.has(msg.id)) continue;
    session.seenMessageIds.add(msg.id);

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
// Smart account parser
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detectDelimiter(line) {
  const delimiters = ['|', ',', ';', '\t', ':'];
  let best = null, bestCount = 0;
  for (const d of delimiters) {
    const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (line.match(new RegExp(escaped, 'g')) || []).length;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best || '|';
}

function parseAccountFields(fields) {
  let email = null, refreshToken = null, clientId = null, password = null;

  for (const raw of fields) {
    const f = raw.trim();
    if (!f) continue;

    if (!email && f.includes('@') && f.includes('.')) {
      email = f;
    } else if (!refreshToken && f.length > 50) {
      refreshToken = f;
    } else if (!clientId && UUID_RE.test(f)) {
      clientId = f;
    } else if (!password) {
      password = f;
    }
  }

  const valid = !!(email && refreshToken && clientId);
  return { email, refreshToken, clientId, password, valid };
}

function parseAccountsText(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const parsed = [];
  const invalidLines = [];
  const lineMap = [];

  for (const line of lines) {
    const delim = detectDelimiter(line);
    const parts = line.split(delim).map(s => s.trim()).filter(Boolean);
    const result = parseAccountFields(parts);

    if (result.valid) {
      lineMap.push({
        email: result.email,
        password: result.password || '',
        refreshToken: result.refreshToken,
        clientId: result.clientId,
        accessToken: null,
        expiresAt: 0,
        expired: false,
        lastError: null,
      });
    } else {
      invalidLines.push({ text: line.substring(0, 80), reason: 'Missing fields (need email, refresh_token, client_id)' });
    }
  }

  return { accounts: lineMap, invalid: invalidLines };
}

// ---------------------------------------------------------------------------
// XLSX parsing helpers
// ---------------------------------------------------------------------------
function detectColumnByHeaders(headers, values) {
  const col = { emailIdx: -1, refreshIdx: -1, clientIdx: -1, passwordIdx: -1 };
  const lowerHeaders = headers.map(h => String(h).toLowerCase().trim());

  // First pass: assign known columns by header keywords
  for (let i = 0; i < lowerHeaders.length; i++) {
    const h = lowerHeaders[i];
    let assigned = false;
    // Email: match "email", "e-mail", "mail", "account", "login", "user"
    if (/email|e-mail|mail|account|login|user/.test(h) && !assigned) { col.emailIdx = i; assigned = true; }
    // Refresh token: match "refresh" or "token" (but not "password" which also has "token" sense)
    if (!assigned && /refresh/.test(h)) { col.refreshIdx = i; assigned = true; }
    // Client ID: match "client" or "cid" or "app"
    if (!assigned && /client|cid|app\b/.test(h)) { col.clientIdx = i; assigned = true; }
    // Password: match "password" or "pass" or "pw" or "secret"
    if (!assigned && /password|pass|pw|secret/.test(h)) { col.passwordIdx = i; assigned = true; }
  }

  // Second pass: leftover column → password (any column not yet assigned)
  if (col.passwordIdx === -1) {
    const assigned = new Set([col.emailIdx, col.refreshIdx, col.clientIdx]);
    for (let i = 0; i < lowerHeaders.length; i++) {
      if (!assigned.has(i)) {
        col.passwordIdx = i;
        break;
      }
    }
  }

  return col;
}

function detectColumnByValues(values) {
  const col = { emailIdx: -1, refreshIdx: -1, clientIdx: -1, passwordIdx: -1 };
  if (values.length === 0) return col;

  const numCols = values[0].length;

  // Score each column for email / refresh / client patterns
  for (let c = 0; c < numCols; c++) {
    let emailScore = 0, refreshScore = 0, clientScore = 0;

    for (let r = 0; r < Math.min(values.length, 5); r++) {
      const v = String(values[r][c] || '').trim();
      if (!v) continue;
      if (v.includes('@') && v.includes('.')) emailScore += 3;
      if (v.length > 50) refreshScore += 3;
      if (UUID_RE.test(v)) clientScore += 3;
    }

    const maxScore = Math.max(emailScore, refreshScore, clientScore);
    if (maxScore === 0) continue;

    if (emailScore === maxScore && col.emailIdx === -1) col.emailIdx = c;
    else if (refreshScore === maxScore && col.refreshIdx === -1) col.refreshIdx = c;
    else if (clientScore === maxScore && col.clientIdx === -1) col.clientIdx = c;
  }

  // Whatever column has data but wasn't multi-scored → password (leftover)
  if (col.passwordIdx === -1) {
    const assigned = new Set([col.emailIdx, col.refreshIdx, col.clientIdx]);
    for (let c = 0; c < numCols; c++) {
      if (assigned.has(c)) continue;
      // Check if column has any data in the first few rows
      for (let r = 0; r < Math.min(values.length, 3); r++) {
        const v = String(values[r][c] || '').trim();
        if (v) {
          col.passwordIdx = c;
          break;
        }
      }
      if (col.passwordIdx !== -1) break;
    }
  }

  return col;
}

function parseXLSXRows(rows, colMap) {
  const accounts = [];
  const invalid = [];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const email = row[colMap.emailIdx] ? String(row[colMap.emailIdx]).trim() : '';
    const refreshToken = row[colMap.refreshIdx] ? String(row[colMap.refreshIdx]).trim() : '';
    const clientId = row[colMap.clientIdx] ? String(row[colMap.clientIdx]).trim() : '';

    // Apply same validation
    const fields = [];
    if (email) fields.push(email);
    if (row[colMap.passwordIdx]) fields.push(String(row[colMap.passwordIdx]).trim());
    if (refreshToken) fields.push(refreshToken);
    if (clientId) fields.push(clientId);

    const result = parseAccountFields(fields);
    if (result.valid) {
      accounts.push({
        email: result.email,
        password: result.password || '',
        refreshToken: result.refreshToken,
        clientId: result.clientId,
        accessToken: null,
        expiresAt: 0,
        expired: false,
        lastError: null,
      });
    } else {
      invalid.push({ text: `Row ${r + 1}: ${email || '(no email)'}`, reason: 'Missing required fields' });
    }
  }

  return { accounts, invalid };
}

// ---------------------------------------------------------------------------
// Full poll cycle for a session (fully concurrent with semaphore)
// ---------------------------------------------------------------------------
async function runPollCycle(session) {
  if (session.isPolling) return; // skip overlapping ticks
  session.isPolling = true;
  session.markActive();
  const startTime = Date.now();

  const activeAccounts = session.accounts.filter(a => !a.expired);
  const total = activeAccounts.length;

  if (total === 0) {
    session.isPolling = false;
    session.lastPollTime = new Date().toISOString();
    pushEvent(session, { type: 'status', message: 'No active accounts to poll' });
    return;
  }

  pushEvent(session, { type: 'status', message: `Fetching ${total} accounts…` });
  pushEvent(session, { type: 'progress', done: 0, total });

  // Use a semaphore to limit concurrency globally across all batches
  const semaphore = pLimit(25);
  let completed = 0;
  const allEmails = [];

  // Create a task for every account immediately — semaphore enforces the concurrency limit
  const tasks = activeAccounts.map(acc =>
    semaphore(async () => {
      const result = await fetchEmails(acc, session).catch(err => {
        acc.expired = true;
        acc.lastError = `Network error: ${err.message}`;
        return [];
      });
      completed++;
      pushEvent(session, { type: 'progress', done: completed, total });
      return result;
    })
  );

  // Wait for all tasks to complete (they run concurrently, capped at 25)
  const results = await Promise.all(tasks);

  for (const emails of results) {
    allEmails.push(...emails);
  }

  // Sort newest first
  allEmails.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

  if (allEmails.length > 0) {
    pushEvent(session, { type: 'emails', emails: allEmails });
  }

  const expiredCount = session.accounts.filter(a => a.expired).length;
  pushEvent(session, {
    type: 'status',
    message: `Loaded ${allEmails.length} new email(s)`,
    expiredCount,
    totalAccounts: session.accounts.length,
  });

  session.lastPollTime = new Date().toISOString();
  session.pollCycleDuration = Date.now() - startTime;
  session.isPolling = false;
}

// ---------------------------------------------------------------------------
// SSE push helper
// ---------------------------------------------------------------------------
function pushEvent(session, data) {
  if (!session.sseResponse) return;
  try {
    session.sseResponse.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* client disconnected */ }
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

// Submit accounts (text paste)
app.post('/session/:sessionId/accounts', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  const raw = (req.body.accounts || '').trim();
  if (!raw) return res.status(400).json({ error: 'No accounts provided' });

  const { accounts, invalid } = parseAccountsText(raw);

  if (accounts.length === 0) {
    return res.status(400).json({ error: 'No valid account lines found', invalid });
  }

  session.accounts = accounts;
  session.lastReceivedDates = {};
  session.seenMessageIds = new Set();

  res.json({ count: accounts.length, invalid, totalInvalid: invalid.length });

  if (session.sseResponse) {
    if (session.pollTimer) clearInterval(session.pollTimer);
    runPollCycle(session);
    // Adaptive interval: poll every max(30s, lastCycleDuration + 5s)
    session.pollTimer = setInterval(() => {
      const interval = Math.max(30_000, session.pollCycleDuration + 5000);
      runPollCycle(session);
    }, 30_000);
  }
});

// XLSX preview — upload file, detect columns, return preview
app.post('/session/:sessionId/xlsx-preview', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  const { file: base64Data } = req.body;
  if (!base64Data) return res.status(400).json({ error: 'No file data provided' });

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    // Filter empty rows
    const rows = jsonData.filter(row => row.some(cell => String(cell).trim() !== ''));

    if (rows.length < 2) {
      return res.status(400).json({ error: 'File has fewer than 2 data rows' });
    }

    const headers = rows[0].map(h => String(h).trim());
    const dataRows = rows.slice(1);

    // Try header-based detection first
    let colMap = detectColumnByHeaders(headers, dataRows);

    // If headers didn't yield a good match, try value-based
    if (colMap.emailIdx === -1 || colMap.refreshIdx === -1 || colMap.clientIdx === -1) {
      colMap = detectColumnByValues(dataRows);
    }

    // Build preview rows (first 5)
    const previewRows = dataRows.slice(0, 5).map(row => ({
      email: row[colMap.emailIdx] || '',
      refreshToken: row[colMap.refreshIdx] || '',
      clientId: row[colMap.clientIdx] || '',
      password: row[colMap.passwordIdx] || '',
    }));

    // Store data for later confirmation
    session.xlsxPreviewData = { rows: dataRows, colMap };

    const detectedCols = {
      email: colMap.emailIdx !== -1 ? (headers[colMap.emailIdx] || `Column ${colMap.emailIdx + 1}`) : 'Not detected',
      refreshToken: colMap.refreshIdx !== -1 ? (headers[colMap.refreshIdx] || `Column ${colMap.refreshIdx + 1}`) : 'Not detected',
      clientId: colMap.clientIdx !== -1 ? (headers[colMap.clientIdx] || `Column ${colMap.clientIdx + 1}`) : 'Not detected',
      password: colMap.passwordIdx !== -1 ? (headers[colMap.passwordIdx] || `Column ${colMap.passwordIdx + 1}`) : 'Not detected',
    };

    res.json({
      totalRows: dataRows.length,
      detectedCols,
      previewRows,
    });
  } catch (err) {
    res.status(400).json({ error: `Failed to parse XLSX: ${err.message}` });
  }
});

// Confirm XLSX and load accounts
app.post('/session/:sessionId/xlsx-confirm', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.xlsxPreviewData) return res.status(400).json({ error: 'No XLSX preview data. Upload first.' });

  session.markActive();
  const { rows, colMap } = session.xlsxPreviewData;

  // Allow override mapping from client
  const mapOverride = req.body.mapping;
  if (mapOverride) {
    if (mapOverride.emailIdx !== undefined) colMap.emailIdx = mapOverride.emailIdx;
    if (mapOverride.refreshIdx !== undefined) colMap.refreshIdx = mapOverride.refreshIdx;
    if (mapOverride.clientIdx !== undefined) colMap.clientIdx = mapOverride.clientIdx;
    if (mapOverride.passwordIdx !== undefined) colMap.passwordIdx = mapOverride.passwordIdx;
  }

  const { accounts, invalid } = parseXLSXRows(rows, colMap);

  session.accounts = accounts;
  session.lastReceivedDates = {};
  session.seenMessageIds = new Set();
  session.xlsxPreviewData = null;

  res.json({ count: accounts.length, invalid, totalInvalid: invalid.length });

  if (session.sseResponse) {
    if (session.pollTimer) clearInterval(session.pollTimer);
    runPollCycle(session);
    // Adaptive interval: poll every max(30s, lastCycleDuration + 5s)
    session.pollTimer = setInterval(() => {
      const interval = Math.max(30_000, session.pollCycleDuration + 5000);
      runPollCycle(session);
    }, 30_000);
  }
});

// Retry expired accounts
app.post('/session/:sessionId/retry-expired', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  let retried = 0;
  for (const acc of session.accounts) {
    if (acc.expired) {
      acc.expired = false;
      acc.lastError = null;
      retried++;
    }
  }

  res.json({ retried });

  // Trigger an immediate poll
  if (session.sseResponse) {
    runPollCycle(session);
  }
});

// Get session status (account + email counts, errors)
app.get('/session/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  const expired = session.accounts
    .filter(a => a.expired && a.lastError)
    .map(a => ({ email: a.email, error: a.lastError }));

  res.json({
    totalAccounts: session.accounts.length,
    activeAccounts: session.accounts.filter(a => !a.expired).length,
    expiredAccounts: expired.length,
    emailsCollected: session.seenMessageIds.size,
    lastPollTime: session.lastPollTime,
    expired,
  });
});

// Export accounts as downloadable text file
app.get('/session/:sessionId/export', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  const lines = session.accounts.map(a => {
    const pass = a.password || '';
    return `${a.email}|${pass}|${a.refreshToken}|${a.clientId}`;
  });

  const content = lines.join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="accounts_export.txt"');
  res.send(content);
});

// SSE stream
app.get('/stream/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.markActive();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const keepAlive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 15_000);

  session.sseResponse = res;

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