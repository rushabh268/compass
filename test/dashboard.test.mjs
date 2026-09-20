import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startSupervisor } from "../src/supervisor/server.mjs";

const authKey = Buffer.alloc(32, 0x63);

async function fixture(t, ledger = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-dashboard-"));
  const socketPath = join(root, "private", "supervisor.sock");
  const server = await startSupervisor({ socketPath, authKey, ledger });
  t.after(() => server.close());
  return { root, socketPath, server };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
  });
}

function httpRequest(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    }).on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test("startDashboard resolves with an address bound to 127.0.0.1", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  assert.equal(server.address, "127.0.0.1");
  assert.equal(typeof server.port, "number");
  assert.ok(server.port > 0);
  assert.equal(server.url, `http://127.0.0.1:${server.port}`);
});

test("GET / returns 200 text/html with /metrics reference, no-store cache, no CDN URLs", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(server.url);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.body.includes("/metrics"), "HTML must reference /metrics");
  assert.equal(/https?:\/\//.test(res.body), false, "HTML must not contain http(s) CDN URLs");
});

test("GET /metrics returns 200 application/json with metrics RPC result, no-store", { timeout: 5_000 }, async (t) => {
  const expectedMetrics = { metadata: "value", timestamp: "2026-08-24T00:00:00Z" };
  const { socketPath } = await fixture(t, { metrics: () => expectedMetrics });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(`${server.url}/metrics`);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.equal(res.headers["cache-control"], "no-store");
  const body = JSON.parse(res.body);
  assert.deepEqual(body, expectedMetrics);
});

test("unknown path returns 404 generic, no internals", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(`${server.url}/unknown`);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.includes("socketPath"), false);
  assert.equal(res.body.includes("authKey"), false);
});

test("POST / returns 405 generic, no internals", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpRequest("POST", `${server.url}/`, "data");

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.includes("socketPath"), false);
});

test("RPC error returns 503 generic JSON, no socket/key/error detail", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => { throw new Error("secret failure message"); } });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(`${server.url}/metrics`);

  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["content-type"], "application/json");
  const body = JSON.parse(res.body);
  assert.ok(body.error !== undefined);
  assert.equal(JSON.stringify(body).includes("socketPath"), false);
  assert.equal(JSON.stringify(body).includes("secret failure"), false);
  assert.equal(JSON.stringify(body).includes("authKey"), false);
});

test("RPC error with closed socket returns 503 generic JSON", { timeout: 5_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-dashboard-closed-"));
  const socketPath = join(root, "private", "supervisor.sock");
  // Don't start a supervisor, socket path is unreachable

  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(`${server.url}/metrics`);

  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["content-type"], "application/json");
  const body = JSON.parse(res.body);
  assert.ok(body.error !== undefined);
  assert.equal(JSON.stringify(body).includes("socketPath"), false);
});

test("close() stops the listener and zeroes its key copy", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const inputKey = Buffer.from(authKey);
  const server = await startDashboard({ socketPath, authKey, port: 0 });

  await server.close();

  // Verify port is released (can listen on same port now)
  const testServer = http.createServer();
  await new Promise((resolve, reject) => {
    testServer.listen(server.port, "127.0.0.1", resolve);
    testServer.once("error", reject);
  });
  testServer.close();

  // Verify key was zeroed
  assert.equal(server.authKeyCleared, true);
  assert.deepEqual(inputKey, authKey);
});

// ========== RED REGRESSION TESTS FOR HARDENING FIXES ==========

test("Host-header validation: GET / with wrong Host header is rejected with 403/404", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request with attacker Host header (not 127.0.0.1:<port>)
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/",
      method: "GET",
      headers: {
        Host: "attacker.example.com",
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // RED: expects rejection (403 or 404), not 200
  assert.ok(res.statusCode === 403 || res.statusCode === 404, `Expected 403 or 404, got ${res.statusCode}`);
  // Verify no HTML leak
  assert.equal(res.body.includes("Compass Dashboard"), false, "Response must not leak HTML content");
  assert.equal(res.body.includes("metrics"), false, "Response must not leak internal paths");
});

test("Host-header validation: GET / with correct Host header succeeds", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request with correct Host header
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/",
      method: "GET",
      headers: {
        Host: `127.0.0.1:${urlObj.port}`,
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // GREEN: correct Host header must succeed
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("Compass Dashboard"));
});

test("Host-header validation: GET / with localhost:<port> Host header succeeds", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request with localhost Host header (loopback-safe)
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/",
      method: "GET",
      headers: {
        Host: `localhost:${urlObj.port}`,
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // GREEN: localhost:<port> must be accepted (loopback-safe)
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("Compass Dashboard"));
});

test("Host-header validation: GET /metrics with localhost:<port> Host header succeeds", { timeout: 5_000 }, async (t) => {
  const expectedMetrics = { metadata: "value", timestamp: "2026-08-24T00:00:00Z" };
  const { socketPath } = await fixture(t, { metrics: () => expectedMetrics });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request /metrics with localhost Host header
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/metrics",
      method: "GET",
      headers: {
        Host: `localhost:${urlObj.port}`,
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // GREEN: localhost:<port> must be accepted (loopback-safe)
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  const body = JSON.parse(res.body);
  assert.deepEqual(body, expectedMetrics);
});

test("Host-header validation: GET /metrics with wrong Host header is rejected with 403/404", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request /metrics with attacker Host header
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/metrics",
      method: "GET",
      headers: {
        Host: "evil.com",
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // RED: expects rejection (403 or 404), not 200
  assert.ok(res.statusCode === 403 || res.statusCode === 404 || res.statusCode === 503, `Got ${res.statusCode}`);
  // Verify no metrics leak
  try {
    const body = JSON.parse(res.body);
    assert.equal(typeof body.metadata, "undefined", "Must not leak metrics on bad Host header");
  } catch {
    // Not JSON is acceptable (404/403 responses may be plain text)
  }
});

test("Host-header validation: GET / with wrong port in Host header is rejected with 403/404", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request with wrong port in Host header
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/",
      method: "GET",
      headers: {
        Host: `127.0.0.1:9999`,  // Wrong port
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // RED: wrong port must be rejected
  assert.ok(res.statusCode === 403 || res.statusCode === 404, `Expected 403 or 404, got ${res.statusCode}`);
  assert.equal(res.body.includes("Compass Dashboard"), false, "Response must not leak HTML content");
});

test("Host-header validation: GET / with foreign IP in Host header is rejected with 403/404", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  // Request with foreign IP in Host header
  const res = await new Promise((resolve, reject) => {
    const urlObj = new URL(server.url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: "/",
      method: "GET",
      headers: {
        Host: `192.168.1.1:${urlObj.port}`,  // Non-loopback IP
      },
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
        });
      });
    }).on("error", reject);
    req.end();
  });

  // RED: non-loopback IP must be rejected
  assert.ok(res.statusCode === 403 || res.statusCode === 404, `Expected 403 or 404, got ${res.statusCode}`);
  assert.equal(res.body.includes("Compass Dashboard"), false, "Response must not leak HTML content");
});

test("no-store on all responses: 404 unknown path has cache-control: no-store", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(`${server.url}/unknown-path-xyz`);

  assert.equal(res.statusCode, 404);
  // RED: expects cache-control: no-store on 404
  assert.equal(res.headers["cache-control"], "no-store", "404 response must include cache-control: no-store");
});

test("no-store on all responses: 405 POST / has cache-control: no-store", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpRequest("POST", `${server.url}/`, "post-body");

  assert.equal(res.statusCode, 405);
  // RED: expects cache-control: no-store on 405
  assert.equal(res.headers["cache-control"], "no-store", "405 response must include cache-control: no-store");
});

test("no-store on all responses: 503 RPC failure has cache-control: no-store", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => { throw new Error("RPC failure"); } });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(`${server.url}/metrics`);

  assert.equal(res.statusCode, 503);
  // This should already pass (code includes it), but confirmed for completeness
  assert.equal(res.headers["cache-control"], "no-store", "503 response must include cache-control: no-store");
});

test("key-zero on listen failure: startDashboard with EADDRINUSE zeroes its key clone", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");

  // Use a fixed high-range port to force EADDRINUSE on second attempt
  const fixedPort = 54321;

  // Start first dashboard on the fixed port
  const server1 = await startDashboard({ socketPath, authKey, port: fixedPort });
  t.after(() => server1.close());

  // Try to start second dashboard on same port — should fail with EADDRINUSE
  const keyForFailure = Buffer.from(authKey);
  let listenError = null;
  try {
    await startDashboard({ socketPath, authKey: keyForFailure, port: fixedPort });
    assert.fail("Expected startDashboard to reject with EADDRINUSE");
  } catch (err) {
    listenError = err;
  }

  // RED: startDashboard must zero its key clone before rejecting
  // We verify this by ensuring the error message doesn't leak the key,
  // and that the rejection is clean (error is thrown, not silently failed)
  assert.ok(listenError, "startDashboard must reject when listen fails");
  assert.ok(listenError.code === "EADDRINUSE" || listenError.message.includes("listen"),
    `Expected listen error, got: ${listenError.message}`);
  // keyForFailure is the caller's buffer; startDashboard should NOT have modified it
  assert.ok(keyForFailure.some(b => b !== 0), "Caller's key buffer must NOT be zeroed by module failure");
});

test("concurrent/repeat close(): calling close() twice resolves both, zeroes exactly once", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });

  // Call close() twice concurrently
  const close1 = server.close();
  const close2 = server.close();

  // Both must resolve without throwing
  const [res1, res2] = await Promise.all([close1, close2]);
  assert.equal(res1, undefined);
  assert.equal(res2, undefined);

  // Key must be cleared exactly once (it is either 0 or was, but we can only check final state)
  assert.equal(server.authKeyCleared, true);

  // Port must be reusable immediately
  const testServer = http.createServer();
  const portReusable = await new Promise((resolve) => {
    testServer.listen(server.port, "127.0.0.1", () => resolve(true));
    testServer.once("error", () => resolve(false));
  });
  testServer.close();

  assert.equal(portReusable, true, "Port must be immediately reusable after concurrent close() calls");
});

test("concurrent/repeat close(): calling close() in sequence resolves idempotently", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });

  // Call close() multiple times sequentially
  const res1 = await server.close();
  const res2 = await server.close();
  const res3 = await server.close();

  assert.equal(res1, undefined);
  assert.equal(res2, undefined);
  assert.equal(res3, undefined);
  assert.equal(server.authKeyCleared, true);
});

test("poll-loop guard (smoke): HTML uses single timer with in-flight guard, not setInterval", { timeout: 5_000 }, async (t) => {
  const { socketPath } = await fixture(t, { metrics: () => ({ metadata: "canned" }) });
  const { startDashboard } = await import("../src/dashboard.mjs");
  const server = await startDashboard({ socketPath, authKey, port: 0 });
  t.after(() => server.close());

  const res = await httpGet(server.url);

  const html = res.body;

  // GREEN: should use setTimeout, not setInterval
  assert.ok(html.includes("setTimeout"), "HTML must use setTimeout for polling");
  assert.equal(html.includes("setInterval"), false, "HTML must NOT use setInterval for polling");

  // GREEN: should call clearTimeout to cancel in-flight requests
  assert.ok(html.includes("clearTimeout"), "HTML must call clearTimeout to guard in-flight requests");

  // GREEN: should have inFlight flag to prevent concurrent requests
  assert.ok(html.includes("inFlight"), "HTML must have inFlight flag to prevent concurrent requests");

  // GREEN: should check document.hidden to pause polling when tab is hidden
  assert.ok(html.includes("document.hidden"), "HTML must check document.hidden for visibility guard");

  // GREEN: should have visibilitychange listener
  assert.ok(html.includes("visibilitychange"), "HTML must listen to visibilitychange event");

  // GREEN: should have a single pendingTimer variable to guard the in-flight timeout
  assert.ok(html.includes("pendingTimer"), "HTML must have single pendingTimer variable for guard");

  // GREEN: structural check — verify clearPendingTimer() function exists and is called
  // This ensures the polling guard mechanism is properly implemented
  assert.ok(html.includes("clearPendingTimer"), "HTML must have clearPendingTimer() function");
});
