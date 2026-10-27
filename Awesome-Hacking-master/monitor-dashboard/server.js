import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import path from "node:path";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_MONITORS = 50;
const MAX_URL_LENGTH = 2048;
const MANUAL_CHECK_COOLDOWN_MS = 5000;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function normalizeAllowedHosts(hosts) {
  const values = Array.isArray(hosts)
    ? hosts
    : typeof hosts === "string"
      ? hosts.trim() ? hosts.split(",") : []
      : [];

  return new Set(values.map((value) => {
    if (typeof value !== "string") {
      throw new Error("Allowed hosts must be strings.");
    }
    const host = value.trim();
    if (!host || host.includes("*")) {
      throw new Error("Allowed hosts must be explicit hostnames; wildcards are not supported.");
    }

    let parsed;
    try {
      parsed = new URL(`http://${host}`);
    } catch {
      throw new Error(`Invalid allowed hostname: ${host}`);
    }

    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`Allowed hosts must contain only a hostname: ${host}`);
    }

    return normalizeHostname(parsed.hostname);
  }));
}

export function parseMonitorConfig({ monitorsJson = "[]", allowedHosts = "" } = {}) {
  let entries;
  try {
    entries = typeof monitorsJson === "string" ? JSON.parse(monitorsJson) : monitorsJson;
  } catch {
    throw new Error("MONITORS_JSON must be valid JSON.");
  }

  if (!Array.isArray(entries) || entries.length > MAX_MONITORS) {
    throw new Error(`MONITORS_JSON must be an array of no more than ${MAX_MONITORS} monitors.`);
  }

  const allowed = normalizeAllowedHosts(allowedHosts);
  const ids = new Set();

  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Monitor ${index + 1} must be an object.`);
    }

    const { id, name, url } = entry;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(id)) {
      throw new Error(`Monitor ${index + 1} has an invalid id.`);
    }
    if (ids.has(id)) {
      throw new Error(`Monitor id "${id}" is duplicated.`);
    }
    ids.add(id);

    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
      throw new Error(`Monitor "${id}" must have a name of 1 to 80 characters.`);
    }
    if (typeof url !== "string" || url.length > MAX_URL_LENGTH) {
      throw new Error(`Monitor "${id}" must have a URL of at most ${MAX_URL_LENGTH} characters.`);
    }

    let target;
    try {
      target = new URL(url);
    } catch {
      throw new Error(`Monitor "${id}" has an invalid URL.`);
    }

    if (!["http:", "https:"].includes(target.protocol)
      || target.username
      || target.password
      || target.search
      || target.hash) {
      throw new Error(`Monitor "${id}" must use HTTP(S) without credentials, a query, or a fragment.`);
    }

    if (!allowed.has(normalizeHostname(target.hostname))) {
      throw new Error(`Monitor "${id}" host "${target.hostname}" is not in MONITOR_ALLOWED_HOSTS.`);
    }

    return Object.freeze({
      id,
      name: name.trim(),
      url: target.href,
      target: `${target.host}${target.pathname}`,
    });
  });
}

export function createMonitorService(monitors, {
  fetchImpl = fetch,
  timeoutMs = 5000,
  now = () => new Date(),
} = {}) {
  const states = new Map(monitors.map((monitor) => [
    monitor.id,
    {
      id: monitor.id,
      name: monitor.name,
      target: monitor.target,
      status: "pending",
      checkedAt: null,
      latencyMs: null,
      httpStatus: null,
      error: null,
    },
  ]));
  const listeners = new Set();
  let activeCheck;

  function getSnapshot() {
    return {
      generatedAt: now().toISOString(),
      monitors: [...states.values()].map((state) => ({ ...state })),
    };
  }

  function publish() {
    const event = `event: snapshot\ndata: ${JSON.stringify(getSnapshot())}\n\n`;
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function checkMonitor(monitor) {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let state;
    try {
      const response = await fetchImpl(monitor.url, {
        method: "GET",
        headers: { accept: "*/*" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.body) {
        await response.body.cancel();
      }

      state = {
        ...states.get(monitor.id),
        status: response.status >= 200 && response.status < 300 ? "up" : "down",
        checkedAt: now().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus: response.status,
        error: response.status >= 200 && response.status < 300
          ? null
          : `Unexpected HTTP status ${response.status}.`,
      };
    } catch (error) {
      state = {
        ...states.get(monitor.id),
        status: "down",
        checkedAt: now().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        httpStatus: null,
        error: controller.signal.aborted
          ? `Request timed out after ${timeoutMs} ms.`
          : `Request failed: ${error instanceof Error ? error.message : "unknown network error"}`,
      };
    } finally {
      clearTimeout(timeout);
    }

    states.set(monitor.id, state);
  }

  async function checkNow() {
    if (!activeCheck) {
      activeCheck = Promise.all(monitors.map(checkMonitor))
        .then(() => {
          publish();
          return getSnapshot();
        })
        .finally(() => {
          activeCheck = undefined;
        });
    }
    return activeCheck;
  }

  return {
    checkNow,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

export function createMonitoringServer({
  monitors = [],
  intervalMs = 30_000,
  timeoutMs = 5000,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const service = createMonitorService(monitors, { fetchImpl, timeoutMs });
  const clients = new Set();
  let interval;
  let started = false;
  let closed = false;
  let lastManualCheckAt = 0;

  const unsubscribe = service.subscribe((event) => {
    for (const response of clients) {
      response.write(event);
    }
  });

  const server = createServer(async (request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Invalid request URL." });
      return;
    }

    if (requestUrl.pathname === "/api/check") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }

      const remainingCooldown = MANUAL_CHECK_COOLDOWN_MS - (Date.now() - lastManualCheckAt);
      if (remainingCooldown > 0) {
        response.setHeader("retry-after", String(Math.ceil(remainingCooldown / 1000)));
        sendJson(response, 429, { error: "A manual check was requested recently. Please wait before trying again." });
        return;
      }

      lastManualCheckAt = Date.now();
      try {
        sendJson(response, 200, await service.checkNow());
      } catch (error) {
        logger.error("Manual monitor check failed:", error);
        sendJson(response, 500, { error: "Could not complete the monitor check." });
      }
      return;
    }

    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (requestUrl.pathname === "/api/status") {
      sendJson(response, 200, service.getSnapshot());
      return;
    }
    if (requestUrl.pathname === "/api/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(`event: snapshot\ndata: ${JSON.stringify(service.getSnapshot())}\n\n`);
      clients.add(response);
      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
      response.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
      return;
    }

    const staticFile = STATIC_FILES.get(requestUrl.pathname);
    if (staticFile) {
      try {
        const body = await readFile(path.join(PUBLIC_DIR, staticFile[0]));
        response.writeHead(200, {
          "content-type": staticFile[1],
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        });
        response.end(body);
      } catch (error) {
        logger.error(`Could not serve ${staticFile[0]}:`, error);
        sendJson(response, 500, { error: "Could not serve the dashboard." });
      }
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  });

  async function start(port = 3000, host = "127.0.0.1") {
    if (started) {
      throw new Error("The monitoring server has already been started.");
    }
    if (closed) {
      throw new Error("The monitoring server has been closed.");
    }

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    started = true;

    await service.checkNow();
    const scheduleNextCheck = () => {
      interval = setTimeout(async () => {
        try {
          await service.checkNow();
        } catch (error) {
          logger.error("Scheduled monitor check failed:", error);
        }
        if (!closed) {
          scheduleNextCheck();
        }
      }, intervalMs);
    };
    scheduleNextCheck();
    return server.address();
  }

  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(interval);
    unsubscribe();
    for (const client of clients) {
      client.end();
    }
    clients.clear();

    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }

  return { server, service, start, close };
}

function readBoundedInteger(name, value, { min, max }) {
  if (!/^\d+$/.test(value ?? "")) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

async function main() {
  const monitors = parseMonitorConfig({
    monitorsJson: process.env.MONITORS_JSON ?? "[]",
    allowedHosts: process.env.MONITOR_ALLOWED_HOSTS ?? "",
  });
  const port = readBoundedInteger("PORT", process.env.PORT ?? "3000", { min: 0, max: 65535 });
  const intervalMs = readBoundedInteger(
    "MONITOR_INTERVAL_MS",
    process.env.MONITOR_INTERVAL_MS ?? "30000",
    { min: 5000, max: 3_600_000 },
  );
  const timeoutMs = readBoundedInteger(
    "MONITOR_TIMEOUT_MS",
    process.env.MONITOR_TIMEOUT_MS ?? "5000",
    { min: 1000, max: 30_000 },
  );
  const host = process.env.HOST ?? "127.0.0.1";
  if (!host.trim()) {
    throw new Error("HOST must not be empty.");
  }

  const app = createMonitoringServer({ monitors, intervalMs, timeoutMs });
  const address = await app.start(port, host);
  console.log(`Monitoring dashboard listening at http://${host}:${address.port}`);
  console.log(`Monitoring ${monitors.length} configured endpoint(s).`);

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Could not start monitoring dashboard: ${error.message}`);
    process.exitCode = 1;
  });
}
