import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startSupervisor } from "../src/supervisor/server.mjs";
import { openLedger } from "../src/state/ledger.mjs";

const cli = new URL("../src/cli.mjs", import.meta.url).pathname;

function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function files() {
  const root = await mkdtemp(join(tmpdir(), "ah-cli-retention-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const ledgerPath = join(root, "ledger", "events.sqlite");
  await writeFile(keyFile, Buffer.alloc(32, 0x63), { mode: 0o600 });
  return { root, keyFile, socketPath, ledgerPath };
}

// ===== CLI Option Parsing Tests =====

test("retention-status CLI command requires --socket and --key-file", async () => {
  const { keyFile, socketPath } = await files();
  const missingSocket = await run(["retention-status", "--key-file", keyFile]);
  assert.notEqual(missingSocket.code, 0);
  assert.match(missingSocket.stderr, /--socket.*required/i);

  const missingKey = await run(["retention-status", "--socket", socketPath]);
  assert.notEqual(missingKey.code, 0);
  assert.match(missingKey.stderr, /--key-file.*required/i);
});

test("prune CLI command requires --socket and --key-file", async () => {
  const { keyFile, socketPath } = await files();
  const missingSocket = await run(["prune", "--key-file", keyFile, "--dry-run", "--older-than-unix", "1700000000", "--max-runs", "100"]);
  assert.notEqual(missingSocket.code, 0);
  assert.match(missingSocket.stderr, /--socket.*required/i);

  const missingKey = await run(["prune", "--socket", socketPath, "--dry-run", "--older-than-unix", "1700000000", "--max-runs", "100"]);
  assert.notEqual(missingKey.code, 0);
  assert.match(missingKey.stderr, /--key-file.*required/i);
});

test("prune CLI requires --dry-run, --older-than-unix, and --max-runs flags", async () => {
  const { keyFile, socketPath } = await files();

  const missingDryRun = await run(["prune", "--socket", socketPath, "--key-file", keyFile, "--older-than-unix", "1700000000", "--max-runs", "100"]);
  assert.notEqual(missingDryRun.code, 0);
  assert.match(missingDryRun.stderr, /--dry-run.*required|unknown option/i);

  const missingOlderThan = await run(["prune", "--socket", socketPath, "--key-file", keyFile, "--dry-run", "--max-runs", "100"]);
  assert.notEqual(missingOlderThan.code, 0);
  assert.match(missingOlderThan.stderr, /--older-than-unix.*required|unknown option|missing value/i);

  const missingMaxRuns = await run(["prune", "--socket", socketPath, "--key-file", keyFile, "--dry-run", "--older-than-unix", "1700000000"]);
  assert.notEqual(missingMaxRuns.code, 0);
  assert.match(missingMaxRuns.stderr, /--max-runs.*required|unknown option|missing value/i);
});

test("prune CLI rejects duplicate options", async () => {
  const { keyFile, socketPath } = await files();
  const result = await run([
    "prune",
    "--socket", socketPath,
    "--socket", join(tmpdir(), "other.sock"),
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "100"
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /duplicate.*--socket/i);
});

test("prune CLI rejects unknown options before making socket connections", async () => {
  const { keyFile } = await files();
  const missingSocket = join(tmpdir(), `missing-${Date.now()}.sock`);
  const result = await run([
    "prune",
    "--socket", missingSocket,
    "--key-file", keyFile,
    "--unknown-flag", "value",
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "100"
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown option.*--unknown-flag/i);
  assert.doesNotMatch(result.stderr, /ENOENT|connect|socket/i);
});

// ===== CLI Output Format Tests =====

test("retention-status CLI outputs valid JSON on one line", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) {
      const result = await run(["retention-status", "--socket", socketPath, "--key-file", keyFile]);
      assert.equal(result.code, 0, result.stderr);

      // Parse and validate JSON output
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 1, "retention-status should output exactly one line");
      const json = JSON.parse(lines[0]);
      assert.ok(typeof json === "object");
      assert.ok("archivedRuns" in json);
      assert.ok("archivedBytes" in json);

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
});

test("prune --dry-run CLI outputs valid JSON with archived list", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) {
      const result = await run([
        "prune",
        "--socket", socketPath,
        "--key-file", keyFile,
        "--dry-run",
        "--older-than-unix", "1700000000",
        "--max-runs", "100"
      ]);
      assert.equal(result.code, 0, result.stderr);

      // Parse and validate JSON output
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 1, "prune should output exactly one line");
      const json = JSON.parse(lines[0]);
      assert.ok(Array.isArray(json.archived), "prune output should have archived array");

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
});

// ===== CLI No Direct DB Access Tests =====

test("retention-status CLI does not open database directly (communicates via socket)", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) {
      // Even if ledgerPath is wrong, should fail via RPC not file error
      const result = await run(["retention-status", "--socket", socketPath, "--key-file", keyFile]);
      assert.equal(result.code, 0, "retention-status should succeed via socket");
      assert.doesNotMatch(result.stderr, /ENOENT|no such file|permission denied/i);

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
});

test("prune CLI does not open database directly (communicates via socket)", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) {
      const result = await run([
        "prune",
        "--socket", socketPath,
        "--key-file", keyFile,
        "--dry-run",
        "--older-than-unix", "1700000000",
        "--max-runs", "100"
      ]);
      assert.equal(result.code, 0, "prune should succeed via socket");
      assert.doesNotMatch(result.stderr, /ENOENT|no such file|permission denied|SQLITE_CANTOPEN/i);

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
});

// ===== CLI Error Handling Tests =====

test("retention-status exits nonzero when RPC fails", async (t) => {
  const { keyFile, socketPath } = await files();
  const supervisor = await startSupervisor({
    socketPath,
    authKey: Buffer.alloc(32, 0x63),
    ledger: {
      retentionStatus() { throw new Error("retention RPC failed"); }
    },
  });
  t.after(() => supervisor.close());

  const result = await run(["retention-status", "--socket", socketPath, "--key-file", keyFile]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /request failed/i);
  assert.equal(result.stdout, "");
});

test("prune exits nonzero when RPC fails", async (t) => {
  const { keyFile, socketPath } = await files();
  const supervisor = await startSupervisor({
    socketPath,
    authKey: Buffer.alloc(32, 0x63),
    ledger: {
      pruneRuns() { throw new Error("prune RPC failed"); }
    },
  });
  t.after(() => supervisor.close());

  const result = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "100"
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /request failed/i);
  assert.equal(result.stdout, "");
});

// ===== CLI Parameter Passing Tests =====

test("prune CLI passes --older-than-unix as integer to RPC", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  let receivedParams;
  const ledger = openLedger({ path: ledgerPath, hmacKey: Buffer.alloc(32, 0x63) });
  t.after(() => ledger.close());

  const supervisor = await startSupervisor({
    socketPath,
    authKey: Buffer.alloc(32, 0x63),
    ledger: {
      ...ledger,
      pruneRuns(params) {
        receivedParams = params;
        return { archived: [] };
      }
    },
  });
  t.after(() => supervisor.close());

  const result = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "50"
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(receivedParams.olderThanUnix, 1700000000);
  assert.equal(receivedParams.maxRuns, 50);
  assert.equal(receivedParams.dryRun, true);
});

test("prune CLI --dry-run flag converts to boolean true in RPC params", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  let receivedDryRun;
  const ledger = openLedger({ path: ledgerPath, hmacKey: Buffer.alloc(32, 0x63) });
  t.after(() => ledger.close());

  const supervisor = await startSupervisor({
    socketPath,
    authKey: Buffer.alloc(32, 0x63),
    ledger: {
      ...ledger,
      pruneRuns(params) {
        receivedDryRun = params.dryRun;
        return { archived: [] };
      }
    },
  });
  t.after(() => supervisor.close());

  const result = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "50"
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(receivedDryRun, true);
  assert.equal(typeof receivedDryRun, "boolean");
});

// ===== CLI Key File Security Tests =====

test("prune CLI rejects permissive key files without making RPC calls", async () => {
  const { root, keyFile, socketPath } = await files();
  const { chmod } = await import("node:fs/promises");
  await chmod(keyFile, 0o644);

  const result = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "100"
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /0600|mode|permission/i);
});

// ===== RED TEST: maxRuns cap validation =====

test("RED: prune CLI rejects --max-runs > 1000", async () => {
  const { keyFile, socketPath } = await files();

  const result = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "1001"
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /max-runs.*1000|1000.*maximum/i);
});

test("RED: prune CLI accepts --max-runs exactly 1000", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) {
      const result = await run([
        "prune",
        "--socket", socketPath,
        "--key-file", keyFile,
        "--dry-run",
        "--older-than-unix", "1700000000",
        "--max-runs", "1000"
      ]);
      assert.equal(result.code, 0, result.stderr);

      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
});

test("RED: prune CLI rejects --max-runs with invalid values (0, negative)", async () => {
  const { keyFile, socketPath } = await files();

  const zeroResult = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "0"
  ]);
  assert.notEqual(zeroResult.code, 0);
  assert.match(zeroResult.stderr, /max-runs|positive|invalid/i);

  const negResult = await run([
    "prune",
    "--socket", socketPath,
    "--key-file", keyFile,
    "--dry-run",
    "--older-than-unix", "1700000000",
    "--max-runs", "-1"
  ]);
  assert.notEqual(negResult.code, 0);
  assert.match(negResult.stderr, /max-runs|positive|invalid|negative/i);
});
