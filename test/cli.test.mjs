import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startSupervisor } from "../src/supervisor/server.mjs";

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
  const root = await mkdtemp(join(tmpdir(), "ah-cli-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const ledgerPath = join(root, "ledger", "events.sqlite");
  await writeFile(keyFile, Buffer.alloc(32, 0x63), { mode: 0o600 });
  return { root, keyFile, socketPath, ledgerPath };
}

test("serve and health communicate through the authenticated Unix socket", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (result.code === 0) {
      assert.equal(result.stdout.trim(), JSON.stringify({ ok: true }));
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      assert.equal(stderr.includes(Buffer.alloc(32, 0x63).toString()), false);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`server did not become healthy: ${stderr}`);
});

test("status and verify print one metadata-only JSON line through the authenticated socket", { timeout: 10_000 }, async (t) => {
  const { keyFile, socketPath, ledgerPath } = await files();
  const child = spawn(process.execPath, [cli, "serve", "--socket", socketPath, "--key-file", keyFile, "--ledger", ledgerPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
    if (health.code === 0) {
      const status = await run(["status", "--socket", socketPath, "--key-file", keyFile]);
      const verify = await run(["verify", "--socket", socketPath, "--key-file", keyFile]);
      assert.equal(status.code, 0, status.stderr);
      assert.equal(verify.code, 0, verify.stderr);
      assert.deepEqual(status.stdout.trim().split("\n").map(JSON.parse), [{ runs: 0, events: 0, states: {} }]);
      assert.deepEqual(verify.stdout.trim().split("\n").map(JSON.parse), [{ valid: 0, invalid: 0 }]);
      assert.equal(status.stdout.trim().split("\n").length, 1);
      assert.equal(verify.stdout.trim().split("\n").length, 1);
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("server did not become healthy");
});

test("status and verify exit nonzero when the authenticated RPC returns an error", async (t) => {
  const { keyFile, socketPath } = await files();
  const supervisor = await startSupervisor({
    socketPath,
    authKey: Buffer.alloc(32, 0x63),
    ledger: {
      status() { throw new Error("status RPC failed"); },
      verifyAll() { throw new Error("verify RPC failed"); },
    },
  });
  t.after(() => supervisor.close());

  for (const command of ["status", "verify"]) {
    const result = await run([command, "--socket", socketPath, "--key-file", keyFile]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /request failed/i);
    assert.equal(result.stdout, "");
  }
});

test("refuses permissive and symlink key files without creating a key", async () => {
  const { root, keyFile, socketPath } = await files();
  await chmod(keyFile, 0o644);
  let result = await run(["health", "--socket", socketPath, "--key-file", keyFile]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /0600|mode|permission/i);

  const target = join(root, "target.key");
  await writeFile(target, Buffer.alloc(32), { mode: 0o600 });
  const linked = join(root, "linked.key");
  await symlink(target, linked, "file");
  result = await run(["health", "--socket", socketPath, "--key-file", linked]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink/i);

  result = await run(["health", "--socket", socketPath, "--key-file", join(root, "missing.key")]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /key file/i);
});

test("rejects unknown and duplicate options before socket or filesystem work", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-cli-options-"));
  const missingKey = join(root, "missing.key");
  const missingSocket = join(root, "missing.sock");
  let result = await run(["health", "--socket", missingSocket, "--key-file", missingKey, "--unknown", "value"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown option.*--unknown/i);
  assert.doesNotMatch(result.stderr, /key file|ENOENT|connect/i);

  result = await run(["health", "--socket", missingSocket, "--socket", join(root, "other.sock"), "--key-file", missingKey]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /duplicate option.*--socket/i);
  assert.doesNotMatch(result.stderr, /key file|ENOENT|connect/i);
});
