import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openLedger } from "../../../src/state/ledger.mjs";
import { startSupervisor } from "../../../src/supervisor/server.mjs";

const hook = new URL("../../../adapters/claude/hook.mjs", import.meta.url).pathname;
const authKey = Buffer.alloc(32, 0x72);

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ah-claude-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const ledger = openLedger({ path: join(root, "ledger", "events.sqlite"), hmacKey: authKey });
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const supervisor = await startSupervisor({ socketPath, authKey, ledger });
  t.after(async () => { await supervisor.close(); ledger.close(); });
  return { root, keyFile, socketPath, ledger };
}

test("identical Claude tool hooks without tool_use_id append for each occurrence", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "native-session",
    cwd: "/secret/repository",
    tool_name: "Bash",
    tool_input: { command: "secret-command" },
    tool_response: "secret-response",
  });
  const env = { COMPASS_SOCKET: socketPath, COMPASS_KEY_FILE: keyFile };

  for (let index = 0; index < 2; index += 1) {
    const result = await runHook(payload, env);
    assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  }

  const runID = (await import("../../../adapters/claude/translate.mjs")).translateClaudeHook(JSON.parse(payload), { authKey }).runID;
  const events = ledger.listEvents(runID);
  assert.equal(events.length, 2);
  assert.equal(JSON.stringify(events).includes("secret-"), false);
});

test("replayed Claude tool hooks with the same tool_use_id append once", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const payload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "native-session",
    tool_use_id: "native-tool-use",
    tool_name: "Bash",
  });
  const env = { COMPASS_SOCKET: socketPath, COMPASS_KEY_FILE: keyFile };

  for (let index = 0; index < 2; index += 1) {
    const result = await runHook(payload, env);
    assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  }

  const runID = (await import("../../../adapters/claude/translate.mjs")).translateClaudeHook(JSON.parse(payload), { authKey }).runID;
  assert.equal(ledger.listEvents(runID).length, 1);
});

test("secret-bearing Claude hooks persist only an observe decision", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const sentinel = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const payload = {
    hook_event_name: "PreToolUse",
    session_id: "native-session",
    tool_use_id: "native-tool-use",
    tool_name: "Bash",
    tool_input: { command: sentinel },
  };
  const result = await runHook(JSON.stringify(payload), {
    COMPASS_SOCKET: socketPath,
    COMPASS_KEY_FILE: keyFile,
  });

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  const runID = (await import("../../../adapters/claude/translate.mjs")).translateClaudeHook(payload, { authKey }).runID;
  const events = ledger.listEvents(runID);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].decision, {
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  });
  assert.equal(JSON.stringify(events).includes(sentinel), false);
});

test("unknown secret-bearing hook event names append nothing", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const payload = JSON.stringify({
    hook_event_name: "Unknown-customer-secret-token",
    session_id: "native-session",
  });
  const result = await runHook(payload, {
    COMPASS_SOCKET: socketPath,
    COMPASS_KEY_FILE: keyFile,
  });

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  const runID = (await import("../../../adapters/claude/translate.mjs")).translateClaudeHook(
    { hook_event_name: "SessionStart", session_id: "native-session" },
    { authKey },
  ).runID;
  assert.equal(ledger.listEvents(runID).length, 0);
});

test("malformed input and unavailable supervisor fail open without output", async (t) => {
  const { root, keyFile, socketPath } = await fixture(t);
  const linkedKey = join(root, "linked.key");
  await symlink(keyFile, linkedKey, "file");
  const cases = [
    ["{", { COMPASS_SOCKET: socketPath, COMPASS_KEY_FILE: keyFile }],
    [JSON.stringify({ hook_event_name: "SessionStart", session_id: "SECRET" }), { COMPASS_SOCKET: join(root, "missing.sock"), COMPASS_KEY_FILE: keyFile }],
    [JSON.stringify({ hook_event_name: "SessionStart", session_id: "SECRET" }), { COMPASS_SOCKET: socketPath, COMPASS_KEY_FILE: linkedKey }],
    ["x".repeat(1024 * 1024 + 1), { COMPASS_SOCKET: socketPath, COMPASS_KEY_FILE: keyFile }],
  ];
  for (const [input, env] of cases) {
    const result = await runHook(input, env);
    assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  }

  await chmod(keyFile, 0o644);
  const permissive = await runHook(JSON.stringify({ hook_event_name: "SessionStart", session_id: "SECRET" }), {
    COMPASS_SOCKET: socketPath,
    COMPASS_KEY_FILE: keyFile,
  });
  assert.deepEqual(permissive, { code: 0, signal: null, stdout: "", stderr: "" });
});

test("malformed UTF-8 stdin fails open without appending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-claude-utf8-"));
  const keyFile = join(root, "auth.key");
  const socketPath = join(root, "private", "supervisor.sock");
  const calls = [];
  await writeFile(keyFile, authKey, { mode: 0o600 });
  const supervisor = await startSupervisor({
    socketPath,
    authKey,
    ledger: {
      ensureRun(runID) { calls.push(["ensureRun", runID]); return { runID, state: "CREATED", created: true }; },
      append(event) { calls.push(["append", event]); return { inserted: true }; },
    },
  });
  t.after(() => supervisor.close());

  const result = await runHook(Buffer.concat([
    Buffer.from('{"hook_event_name":"SessionStart","session_id":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}'),
  ]), {
    COMPASS_SOCKET: socketPath,
    COMPASS_KEY_FILE: keyFile,
  });

  assert.deepEqual(result, { code: 0, signal: null, stdout: "", stderr: "" });
  assert.deepEqual(calls.filter(([method]) => method === "append"), []);
});

test("legacy hook environment reaches the same ledger and explicit invalid Compass key does not fall back", async (t) => {
  const { keyFile, socketPath, ledger } = await fixture(t);
  const payload = { hook_event_name: "PostToolUse", session_id: "legacy-session", tool_use_id: "legacy-use", tool_name: "Bash" };
  const env = { COMPASS_SOCKET: undefined, COMPASS_KEY_FILE: undefined, AGENT_HARNESS_SOCKET: socketPath, AGENT_HARNESS_KEY_FILE: keyFile };
  assert.equal((await runHook(JSON.stringify(payload), env)).code, 0);
  const { translateClaudeHook } = await import("../../../adapters/claude/translate.mjs");
  const runID = translateClaudeHook(payload, { authKey }).runID;
  assert.equal(ledger.listEvents(runID).length, 1);
  await runHook(JSON.stringify({ ...payload, tool_use_id: "must-not-append" }), { ...env, COMPASS_KEY_FILE: "" });
  assert.equal(ledger.listEvents(runID).length, 1);
});
