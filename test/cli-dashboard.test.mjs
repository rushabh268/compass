import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startSupervisor } from "../src/supervisor/server.mjs";

const cli = new URL("../src/cli.mjs", import.meta.url).pathname;
const authKey = Buffer.alloc(32, 0x63);

function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, child }));
  });
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

async function fixture(t, ledger = {}) {
  const root = await mkdtemp(join(tmpdir(), "ah-cli-dashboard-"));
  const socketPath = join(root, "private", "supervisor.sock");
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const server = await startSupervisor({ socketPath, authKey, ledger });
  t.after(() => server.close());
  return { root, socketPath, keyFile, server };
}

test("dashboard command spawns, prints readiness JSON, serves metrics, and exits cleanly on SIGTERM", { timeout: 10_000 }, async (t) => {
  const { socketPath, keyFile } = await fixture(t, { metrics: () => ({ metadata: "live", timestamp: "2026-08-24T00:00:00Z" }) });

  const child = spawn(process.execPath, [cli, "dashboard", "--socket", socketPath, "--key-file", keyFile, "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const chunks = [];

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    chunks.push(chunk.toString());
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => child.kill("SIGTERM"));

  // Poll for readiness JSON line
  let readinessParsed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (stdout.includes("\n")) {
      const lines = stdout.split("\n").filter(Boolean);
      if (lines.length > 0) {
        try {
          readinessParsed = JSON.parse(lines[0]);
          break;
        } catch {
          // Not yet valid JSON
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(readinessParsed, `no readiness JSON parsed from stdout: ${stdout}`);
  assert.ok(readinessParsed.url, "readiness JSON must have url field");
  assert.match(readinessParsed.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // Verify only ONE readiness line
  const lines = stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly 1 line, got ${lines.length}: ${stdout}`);

  // GET / and /metrics to verify 127.0.0.1 + metadata-only
  const getRes = await httpGet(`${readinessParsed.url}/`);
  assert.equal(getRes.statusCode, 200);

  const metricsRes = await httpGet(`${readinessParsed.url}/metrics`);
  assert.equal(metricsRes.statusCode, 200);
  const metricsBody = JSON.parse(metricsRes.body);
  assert.deepEqual(metricsBody, { metadata: "live", timestamp: "2026-08-24T00:00:00Z" });

  // SIGTERM and verify clean exit
  child.kill("SIGTERM");
  const closed = new Promise((resolve) => child.once("close", resolve));
  const exitCode = await closed;
  assert.ok(exitCode === 0 || exitCode === null, `child exited with code ${exitCode}`);
});

test("dashboard rejects missing --socket before any socket work", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-cli-dashboard-missing-"));
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o600 });

  const result = await run(["dashboard", "--key-file", keyFile]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--socket|required/i);
});

test("dashboard rejects missing --key-file before any key file work", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-cli-dashboard-missing-"));
  const socketPath = join(root, "supervisor.sock");

  const result = await run(["dashboard", "--socket", socketPath]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--key-file|required/i);
});

test("dashboard rejects --port out of range 0..65535", async () => {
  const { socketPath, keyFile } = await fixture(test, { metrics: () => ({}) });

  for (const invalidPort of ["-1", "65536", "100000"]) {
    const result = await run(["dashboard", "--socket", socketPath, "--key-file", keyFile, "--port", invalidPort]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--port|0.*65535|range/i);
  }
});

test("dashboard rejects --refresh-seconds out of range 1..300", async () => {
  const { socketPath, keyFile } = await fixture(test, { metrics: () => ({}) });

  for (const invalidRefresh of ["0", "301", "1000"]) {
    const result = await run(["dashboard", "--socket", socketPath, "--key-file", keyFile, "--refresh-seconds", invalidRefresh]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--refresh-seconds|1.*300|range/i);
  }
});

test("dashboard refuses a permissive key file without starting", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-cli-dashboard-perm-"));
  const socketPath = join(root, "supervisor.sock");
  const keyFile = join(root, "auth.key");
  await writeFile(keyFile, authKey, { mode: 0o644 });

  const result = await run(["dashboard", "--socket", socketPath, "--key-file", keyFile]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /0600|mode|permission/i);
});
