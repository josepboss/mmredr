# MailReader

The deployed app is this Express service, independent of the React/Vite starter at the repository root.

## Local development

```sh
cd mailreader
npm install
npm start
```

Open `http://localhost:9320` for MailReader or `http://localhost:9320/2FA` for the 2FA generator. Node.js 20 or newer is required. Run `npm test` in this folder to verify the TOTP implementation against RFC 6238 test vectors.

## 2FA generator

`/2FA` runs entirely in the visitor's browser using Web Crypto. It accepts Base32 secrets and produces six-digit SHA-1 TOTP codes with a 30-second period, including the next code, a countdown, and click to copy. It does not send, persist, or put secrets in URLs. It requires HTTPS in production (localhost works for development). The visitor's clock must be accurate.

No new packages or frontend build are needed for this tool. It is served by the same Express process as MailReader.

## Existing VPS deployment

Repository: `/opt/mmredr`. PM2 runs `/opt/mmredr/mailreader/server.js` as `mailreader` on port 9320. Nginx proxies `mailreader.top` to that process.

After reviewing and committing the local changes, manually pull them on the VPS and restart **only** MailReader so Express registers the new route:

```sh
cd /opt/mmredr
git pull --ff-only
pm2 restart mailreader
curl --fail https://mailreader.top/health
curl --fail --head https://mailreader.top/2FA
```

No Nginx change or other PM2 process restart is required. Sessions are held in memory, so restarting MailReader clears its current monitoring sessions.
