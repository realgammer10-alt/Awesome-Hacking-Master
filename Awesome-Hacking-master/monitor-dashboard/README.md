# Endpoint Monitor

A small, dependency-free dashboard for checking explicitly configured HTTP endpoints. It is a standalone addition to the Awesome Hacking resource list; it does not scan for services or accept monitor targets over its API.

## Requirements and start

Requires Node.js 20 or newer. From this directory:

```powershell
npm test
npm start
```

Open <http://127.0.0.1:3000>. With no targets configured, the dashboard shows an empty state and the application health endpoint remains available at `/api/health`.

## Configure authorized endpoints

Set both environment variables before starting the server. The host allowlist must contain each exact hostname from the configured URLs; wildcards, redirects, credentials, query strings, and fragments are not supported. Configure only endpoints you own or are authorized to monitor.

PowerShell example:

```powershell
$env:MONITOR_ALLOWED_HOSTS = "api.example.com,status.example.com"
$env:MONITORS_JSON = '[{"id":"public-api","name":"Public API","url":"https://api.example.com/health"},{"id":"status","name":"Status service","url":"https://status.example.com/health"}]'
npm start
```

Checks issue an HTTP `GET` every 30 seconds by default and consider 2xx responses healthy. Set `MONITOR_INTERVAL_MS` to an integer from 5000 to 3600000 and `MONITOR_TIMEOUT_MS` to an integer from 1000 to 30000 to adjust the interval and per-request timeout. The dashboard binds to `127.0.0.1` by default; set `HOST` and `PORT` only when you intentionally need a different listening address.

## API

- `GET /api/health` — application liveness.
- `GET /api/status` — current endpoint states as JSON.
- `GET /api/events` — server-sent events (`snapshot`) for live dashboard updates.
- `POST /api/check` — immediately checks configured endpoints and returns a status snapshot. Manual requests are limited to one every five seconds.

Each monitor has a stable ID, a display name, and an authorized HTTP(S) URL. Status responses include `pending`, `up`, or `down`, the last check time, latency, HTTP status when available, and a concise error on failure. Target configuration is read only from the process environment; the API does not allow targets to be added or changed.
