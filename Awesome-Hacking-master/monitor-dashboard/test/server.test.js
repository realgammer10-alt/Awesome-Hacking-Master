import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createMonitorService, createMonitoringServer, parseMonitorConfig } from "../server.js";

let fixture;
let fixtureUrl;
let fixtureStatus = 503;
let app;
let appUrl;

before(async () => {
  fixture = createHttpServer((request, response) => {
    response.writeHead(fixtureStatus, { "content-type": "text/plain" });
    response.end("fixture");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}/health`;

  const monitors = parseMonitorConfig({
    monitorsJson: JSON.stringify([
      { id: "fixture", name: "Fixture API", url: fixtureUrl },
    ]),
    allowedHosts: "127.0.0.1",
  });
  app = createMonitoringServer({ monitors, intervalMs: 60_000 });
  const address = await app.start(0, "127.0.0.1");
  appUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (app) await app.close();
  if (fixture?.listening) {
    fixture.close();
    await once(fixture, "close");
  }
});

test("accepts configured endpoints only when their hostname is explicitly allowed", () => {
  const monitors = parseMonitorConfig({
    monitorsJson: [{ id: "api-1", name: "Public API", url: "https://api.example.test/health" }],
    allowedHosts: ["api.example.test"],
  });
  assert.equal(monitors[0].target, "api.example.test/health");

  assert.throws(
    () => parseMonitorConfig({
      monitorsJson: [{ id: "other", name: "Other API", url: "https://other.example.test/health" }],
      allowedHosts: ["api.example.test"],
    }),
    /not in MONITOR_ALLOWED_HOSTS/,
  );
  assert.deepEqual(parseMonitorConfig().length, 0);
  assert.throws(() => parseMonitorConfig({ allowedHosts: ["api.example.test", 4] }), /must be strings/);
});

test("rejects malformed, duplicate, credentialed, queried, and unsupported monitor targets", () => {
  assert.throws(() => parseMonitorConfig({ monitorsJson: "{" }), /valid JSON/);
  assert.throws(() => parseMonitorConfig({ monitorsJson: {} }), /must be an array/);
  assert.throws(
    () => parseMonitorConfig({
      allowedHosts: "api.example.test",
      monitorsJson: [
        { id: "same", name: "First", url: "https://api.example.test/health" },
        { id: "same", name: "Second", url: "https://api.example.test/health" },
      ],
    }),
    /duplicated/,
  );
  for (const url of [
    "https://user:pass@api.example.test/health",
    "https://api.example.test/health?token=secret",
    "file:///etc/passwd",
  ]) {
    assert.throws(
      () => parseMonitorConfig({
        allowedHosts: "api.example.test",
        monitorsJson: [{ id: "bad", name: "Bad target", url }],
      }),
      /must use HTTP\(S\)/,
    );
  }
});

test("reports endpoint health and serves the status and health APIs", async () => {
  let response = await fetch(`${appUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });

  let result = await app.service.getSnapshot();
  assert.equal(result.monitors[0].status, "down");
  assert.equal(result.monitors[0].httpStatus, 503);

  fixtureStatus = 204;
  result = await app.service.checkNow();
  assert.equal(result.monitors[0].status, "up");
  assert.equal(result.monitors[0].httpStatus, 204);
  assert.equal(typeof result.monitors[0].latencyMs, "number");

  response = await fetch(`${appUrl}/api/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).monitors[0].status, "up");
});

test("runs an on-demand check and throttles repeated manual requests", async () => {
  fixtureStatus = 503;
  let response = await fetch(`${appUrl}/api/check`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).monitors[0].status, "down");

  response = await fetch(`${appUrl}/api/check`, { method: "POST" });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 1);

  response = await fetch(`${appUrl}/api/check`);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("rechecks configured endpoints automatically", async () => {
  fixtureStatus = 503;
  const monitors = parseMonitorConfig({
    monitorsJson: JSON.stringify([{ id: "periodic", name: "Periodic API", url: fixtureUrl }]),
    allowedHosts: "127.0.0.1",
  });
  const periodicApp = createMonitoringServer({ monitors, intervalMs: 25 });

  try {
    await periodicApp.start(0, "127.0.0.1");
    assert.equal(periodicApp.service.getSnapshot().monitors[0].status, "down");

    const nextHealthySnapshot = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("The scheduled monitor check did not publish an update."));
      }, 1000);
      const unsubscribe = periodicApp.service.subscribe((event) => {
        if (event.includes('"status":"up"')) {
          clearTimeout(timeout);
          unsubscribe();
          resolve();
        }
      });
    });

    fixtureStatus = 200;
    await nextHealthySnapshot;
    assert.equal(periodicApp.service.getSnapshot().monitors[0].status, "up");
  } finally {
    await periodicApp.close();
  }
});

test("marks a timed-out endpoint as down with a clear error", async () => {
  const monitors = parseMonitorConfig({
    monitorsJson: [{ id: "slow", name: "Slow API", url: "https://api.example.test/health" }],
    allowedHosts: "api.example.test",
  });
  const service = createMonitorService(monitors, {
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });

  const result = await service.checkNow();
  assert.equal(result.monitors[0].status, "down");
  assert.equal(result.monitors[0].httpStatus, null);
  assert.match(result.monitors[0].error, /timed out after 10 ms/);
});

test("streams status changes to connected dashboard clients", async () => {
  fixtureStatus = 503;
  await app.service.checkNow();
  const response = await fetch(`${appUrl}/api/events`);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const firstEvent = await reader.read();
  assert.match(decoder.decode(firstEvent.value), /event: snapshot/);

  fixtureStatus = 200;
  await app.service.checkNow();
  const nextEvent = await reader.read();
  const payload = decoder.decode(nextEvent.value);
  assert.match(payload, /"status":"up"/);

  await reader.cancel();
});

test("serves dashboard assets and rejects unsupported methods and paths", async () => {
  let response = await fetch(appUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Endpoint health/);

  response = await fetch(`${appUrl}/app.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);

  response = await fetch(`${appUrl}/api/status`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");

  response = await fetch(`${appUrl}/api/health`, { method: "POST" });
  assert.equal(response.status, 405);

  response = await fetch(`${appUrl}/missing`);
  assert.equal(response.status, 404);
});
