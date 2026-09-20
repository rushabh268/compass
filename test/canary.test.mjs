import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openLedger } from "../src/state/ledger.mjs";
import { request } from "../src/supervisor/client.mjs";

const cli = new URL("../src/cli.mjs", import.meta.url).pathname;
const key = Buffer.alloc(32, 0x63);
const sentinel = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function files() {
  const root = await mkdtemp(join(tmpdir(), "ah-canary-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const ledgerPath = join(root, "ledger", "events.sqlite");
  await writeFile(keyFile, key, { mode: 0o600 });
  return { root, keyFile, socketPath, ledgerPath };
}

async function startServe(t, { keyFile, socketPath, ledgerPath }) {
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) return child;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
}

async function readStateBytes(ledgerPath) {
  const paths = [ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`];
  const contents = [];
  for (const path of paths) {
    try { contents.push(await readFile(path)); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return Buffer.concat(contents);
}

test("canary translates three adapters through the real supervisor, ledger, and metrics", { timeout: 15_000 }, async (t) => {
  const paths = await files();
  await startServe(t, paths);

  const result = await run([
    "canary", "--socket", paths.socketPath, "--key-file", paths.keyFile, "--ledger", paths.ledgerPath,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, events: 3, rawSentinelMatches: 0 });
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);

  const ledger = openLedger({ path: paths.ledgerPath, hmacKey: key });
  t.after(() => ledger.close());
  assert.deepEqual(ledger.status(), { runs: 3, events: 3, states: { CREATED: 3 } });
  assert.deepEqual(ledger.verifyAll(), { valid: 3, invalid: 0 });

  const db = new DatabaseSync(paths.ledgerPath);
  const rows = db.prepare("SELECT run_id, event_count FROM runs ORDER BY run_id").all();
  const eventRows = db.prepare("SELECT body, dedupe_key FROM events ORDER BY id").all();
  assert.deepEqual(rows.map(({ event_count }) => event_count), [1, 1, 1]);
  assert.equal(eventRows.length, 3);
  db.close();

  const listed = [];
  for (const { run_id: runID } of rows) {
    const page = ledger.listEventsPage(runID, { cursor: 0, limit: 1 });
    assert.equal(page.events.length, 1);
    assert.equal(page.nextCursor, null);
    listed.push(...page.events);
  }
  assert.deepEqual(listed.map(({ platform }) => platform).sort(), ["claude", "codex", "opencode"]);
  assert.equal(listed.filter(({ decision }) => decision?.action === "observe").length, 3);

  const metrics = await request({ socketPath: paths.socketPath, authKey: key, method: "metrics", params: {} });
  assert.deepEqual(metrics.platforms, { claude: 1, codex: 1, opencode: 1 });
  assert.equal(metrics.dlp.observeDecisions, 3);
  assert.equal(JSON.stringify(metrics).includes(sentinel), false);

  const bytes = await readStateBytes(paths.ledgerPath);
  assert.equal(bytes.includes(Buffer.from('"eventType":"PreToolUse"')), true);
  assert.equal(bytes.includes(Buffer.from(eventRows[0].dedupe_key)), true);
  assert.equal(bytes.includes(Buffer.from(sentinel)), false);
  assert.equal(bytes.toString("utf8").split(sentinel).length - 1, 0);
});

test("canary exits nonzero when the supervisor ledger differs from the requested ledger", { timeout: 15_000 }, async (t) => {
  const paths = await files();
  await startServe(t, paths);

  const missingLedger = join(paths.root, "ledger-b", "events.sqlite");
  const result = await run([
    "canary", "--socket", paths.socketPath, "--key-file", paths.keyFile, "--ledger", missingLedger,
  ]);

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, /"ok"\s*:\s*true/);
});

test("canary exits nonzero when full-ledger integrity is already broken", { timeout: 15_000 }, async (t) => {
  const paths = await files();
  const ledger = openLedger({ path: paths.ledgerPath, hmacKey: key });
  ledger.createRun("preexisting-invalid-run");
  ledger.append({
    schemaVersion: 1,
    eventID: "preexisting-invalid-event",
    runID: "preexisting-invalid-run",
    platform: "claude",
    sessionHMAC: "3".repeat(64),
    eventType: "PreToolUse",
    timestamp: "2026-08-24T12:34:56.000Z",
    dedupeKey: "preexisting-invalid:call-1",
  });
  ledger.close();
  const db = new DatabaseSync(paths.ledgerPath);
  db.exec("UPDATE events SET body = replace(body, 'PreToolUse', 'PostToolUse')");
  db.close();

  await startServe(t, paths);
  const result = await run([
    "canary", "--socket", paths.socketPath, "--key-file", paths.keyFile, "--ledger", paths.ledgerPath,
  ]);

  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stderr, /unknown command/i);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr.includes(sentinel), false);
});
