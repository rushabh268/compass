import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { translateCodexHook } from "../../../adapters/codex/translate.mjs";
import { createEvent } from "../../../src/protocol/event.mjs";

const authKey = Buffer.alloc(32, 0x63);
const now = new Date("2026-09-19T12:34:56.000Z");
const options = { authKey, now, occurrenceID: "callback-one" };
const syntheticBearer = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";

function payload(overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "native-session",
    turn_id: "native-turn",
    cwd: "/private/project",
    transcript_path: "/private/rollout.jsonl",
    model: "private-model-deployment",
    permission_mode: "default",
    tool_name: "Bash",
    tool_use_id: "native-tool-call",
    tool_input: { command: "printf private-input" },
    ...overrides,
  };
}

test("Codex translation produces only a closed, frozen metadata envelope", () => {
  const input = payload();
  const event = translateCodexHook(input, options);
  assert.ok(event, "Codex translation must produce an event");
  assert.deepEqual(Object.keys(event).sort(), [
    "adapterVersion", "callID", "dedupeKey", "eventID", "eventType", "platform", "runID",
    "schemaVersion", "sessionHMAC", "timestamp", "toolName", "worktreeID",
  ].sort());
  assert.equal(event.platform, "codex");
  assert.equal(event.eventType, "PreToolUse");
  assert.equal(event.toolName, "Bash");
  assert.equal(event.timestamp, now.toISOString());
  assert.equal(Object.isFrozen(event), true);
  assert.deepEqual(createEvent(JSON.parse(JSON.stringify(event))), event);
  const serialized = JSON.stringify(event);
  for (const value of [
    input.session_id, input.turn_id, input.cwd, input.transcript_path, input.model,
    input.tool_use_id, input.tool_input.command, options.occurrenceID,
  ]) assert.equal(serialized.includes(value), false);
  for (const field of ["runID", "sessionHMAC", "callID", "worktreeID", "eventID", "dedupeKey"]) {
    assert.match(event[field], /^[0-9a-f]{64}$/);
  }
  assert.notEqual(event.runID, event.sessionHMAC);
  assert.notEqual(event.eventID, event.dedupeKey);
  assert.deepEqual(translateCodexHook(input, options), event);
  assert.deepEqual(authKey, Buffer.alloc(32, 0x63), "translation must not wipe the caller's key");
});

test("Codex translates all twelve documented hook events including failure output and Interrupt", () => {
  const turn = { turn_id: "native-turn", permission_mode: "default" };
  const tool = { ...turn, tool_name: "Bash", tool_use_id: "native-tool-call", tool_input: { command: "pwd" } };
  const examples = {
    SessionStart: { source: "startup", permission_mode: "default" },
    SessionEnd: { reason: "other" },
    SubagentStart: { ...turn, agent_id: "child-session", agent_type: "worker" },
    SubagentStop: { ...turn, agent_id: "child-session", agent_type: "worker", agent_transcript_path: null, stop_hook_active: false, last_assistant_message: "finished" },
    PreToolUse: tool,
    PermissionRequest: { ...turn, tool_name: "Bash", tool_input: { command: "pwd" } },
    PostToolUse: { ...tool, tool_response: { exit_code: 1, output: "failed" } },
    PreCompact: { turn_id: "native-turn", trigger: "auto" },
    PostCompact: { turn_id: "native-turn", trigger: "manual" },
    UserPromptSubmit: { ...turn, prompt: "Review this change" },
    Stop: { ...turn, stop_hook_active: false, last_assistant_message: null },
    Interrupt: turn,
  };
  for (const [eventType, fields] of Object.entries(examples)) {
    const input = {
      hook_event_name: eventType, session_id: "native-session",
      transcript_path: null, cwd: "/project", model: "codex", ...fields,
    };
    const event = translateCodexHook(input, options);
    assert.ok(event, eventType);
    assert.equal(event.eventType, eventType);
  }
});

test("Codex rejects unsupported hook names without echoing their values", () => {
  for (const name of ["PostToolUseFailure", "WebSearch", "private-event-sentinel", ""]) {
    assert.throws(() => translateCodexHook(payload({ hook_event_name: name }), options), (error) => {
      assert.match(error.message, /hook_event_name/);
      if (name) assert.equal(error.message.includes(name), false);
      return true;
    });
  }
});

test("Codex assigns separate identities to identical callbacks even with a native tool ID", () => {
  const first = translateCodexHook(payload(), options);
  const second = translateCodexHook(payload(), { ...options, now: new Date(now.getTime() + 1), occurrenceID: "callback-two" });
  assert.ok(first && second);
  assert.notEqual(first.eventID, second.eventID);
  assert.notEqual(first.dedupeKey, second.dedupeKey);
  assert.equal(first.callID, second.callID);
  const generatedOne = translateCodexHook(payload(), { authKey, now });
  const generatedTwo = translateCodexHook(payload(), { authKey, now });
  assert.notEqual(generatedOne.eventID, generatedTwo.eventID);
});

test("Codex identities separate sessions, turns and phases while pre/post correlate one tool call", () => {
  const first = translateCodexHook(payload(), options);
  const post = translateCodexHook(payload({ hook_event_name: "PostToolUse", tool_response: "done" }), options);
  const otherSession = translateCodexHook(payload({ session_id: "another-session" }), options);
  const otherTurn = translateCodexHook(payload({ turn_id: "another-turn" }), options);
  assert.ok(first && post && otherSession && otherTurn);
  assert.equal(first.callID, post.callID);
  for (const other of [post, otherSession, otherTurn]) {
    assert.notEqual(first.eventID, other.eventID);
    assert.notEqual(first.dedupeKey, other.dedupeKey);
  }
  assert.notEqual(first.callID, otherSession.callID);
  assert.notEqual(first.callID, otherTurn.callID);
});

test("Codex subagent hooks link the child to the documented parent session", () => {
  const parent = translateCodexHook({ hook_event_name: "SessionStart", session_id: "parent" }, options);
  const childStart = translateCodexHook({
    hook_event_name: "SubagentStart", session_id: "parent", agent_id: "child", agent_type: "worker",
  }, options);
  const childStop = translateCodexHook({
    hook_event_name: "SubagentStop", session_id: "parent", agent_id: "child", last_assistant_message: null,
  }, options);
  const childTool = translateCodexHook(payload({ session_id: "child" }), options);
  assert.ok(parent && childStart && childStop && childTool);
  assert.equal(childStart.runID, parent.runID);
  assert.equal(childStart.parentSessionHMAC, parent.sessionHMAC);
  assert.equal(childStop.parentSessionHMAC, parent.sessionHMAC);
  assert.equal(childStart.sessionHMAC, childTool.sessionHMAC);
  assert.equal(childStart.sessionHMAC, childStop.sessionHMAC);
  assert.notEqual(childStart.sessionHMAC, parent.sessionHMAC);
  const otherChild = translateCodexHook({
    hook_event_name: "SubagentStart", session_id: "parent", agent_id: "other-child",
  }, options);
  assert.notEqual(childStart.eventID, otherChild.eventID);
  assert.throws(() => translateCodexHook({
    hook_event_name: "SubagentStart", session_id: "parent",
  }, options), /agent_id/);
});

test("Codex identity tuples cannot collide through embedded separators", () => {
  const one = translateCodexHook(payload({ session_id: "session\0Stop", turn_id: "turn" }), options);
  const two = translateCodexHook(payload({ session_id: "session", turn_id: "Stop\0turn" }), options);
  assert.ok(one && two);
  assert.notEqual(one.eventID, two.eventID);
  assert.notEqual(one.callID, two.callID);
});

test("Codex stores canonical names only for verified local tool mappings", () => {
  for (const [native, canonical] of [["Bash", "Bash"], ["apply_patch", "ApplyPatch"], ["spawn_agent", "Task"]]) {
    assert.equal(translateCodexHook(payload({ tool_name: native }), options)?.toolName, canonical);
  }
  for (const native of ["mcp__private_service__secret_tool", "update_plan", "Agent", "WebSearch"]) {
    const event = translateCodexHook(payload({ tool_name: native }), options);
    assert.ok(event);
    assert.match(event.toolName, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(event).includes(native), false);
  }
});

test("Codex observes credentials anywhere in the payload without storing source content", () => {
  for (const fields of [
    { prompt: syntheticBearer },
    { tool_input: { command: syntheticBearer } },
    { tool_response: { output: syntheticBearer } },
    { last_assistant_message: syntheticBearer },
    { future_extension: [syntheticBearer] },
  ]) {
    const event = translateCodexHook(payload(fields), options);
    assert.ok(event);
    assert.deepEqual(event.decision, {
      schemaVersion: 1, action: "observe", ruleIDs: ["dlp.bearer-token"],
      reason: "Credential-shaped content was observed",
    });
    assert.equal(JSON.stringify(event).includes(syntheticBearer), false);
    assert.equal(Object.isFrozen(event.decision.ruleIDs), true);
  }
  const safe = translateCodexHook(payload({ decision: "block", continue: false }), options);
  assert.equal(Object.hasOwn(safe, "decision"), false);
  assert.equal(Object.hasOwn(safe, "continue"), false);
});

test("Codex safely scans own __proto__ fields and ignores inherited metadata", () => {
  const input = JSON.parse('{"hook_event_name":"SessionStart","session_id":"session","__proto__":{"prompt":"Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0"}}');
  const event = translateCodexHook(input, options);
  assert.ok(event);
  assert.equal(event.decision.action, "observe");
  assert.equal(Object.hasOwn(Object.prototype, "prompt"), false);
  assert.equal(Object.getPrototypeOf(input), Object.prototype);
});

test("Codex omits unavailable optional metadata", () => {
  const event = translateCodexHook({ hook_event_name: "SessionStart", session_id: "session" }, options);
  assert.ok(event);
  assert.deepEqual(Object.keys(event).sort(), [
    "adapterVersion", "dedupeKey", "eventID", "eventType", "platform", "runID",
    "schemaVersion", "sessionHMAC", "timestamp",
  ].sort());
});

test("Codex rejects non-JSON payloads without invoking proxies or accessors", () => {
  const accessor = payload();
  Object.defineProperty(accessor, "prompt", { enumerable: true, get() { assert.fail("getter executed"); } });
  const arrayAccessor = ["value"];
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get() { assert.fail("array getter executed"); } });
  const arrayExtra = ["value"];
  arrayExtra.extra = "hidden";
  const arrayPrototype = ["value"];
  Object.setPrototypeOf(arrayPrototype, null);
  const cyclic = payload();
  cyclic.self = cyclic;
  const hidden = payload();
  Object.defineProperty(hidden, "hidden", { value: "content" });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const cases = [
    null, [], Object.create(null), new Date(), new Proxy(payload(), { get() { assert.fail("proxy executed"); } }),
    payload({ value: revoked.proxy }), accessor, hidden, cyclic,
    payload({ value: arrayAccessor }), payload({ value: arrayExtra }), payload({ value: arrayPrototype }),
    payload({ value: new Array(10) }), payload({ value: new Date() }), payload({ value: new Map() }),
    payload({ value: undefined }), payload({ value: NaN }), payload({ value: Infinity }), payload({ value: 1n }),
    payload({ value: () => {} }), payload({ value: Symbol("private") }), payload({ [Symbol("field")]: "private" }),
  ];
  for (const input of cases) assert.throws(() => translateCodexHook(input, options), /JSON|plain|payload/i);
});

test("Codex bounds payload bytes, nesting and value count before scanning", () => {
  for (const text of ["x".repeat(1024 * 1024), "😀".repeat(300_000), "\0".repeat(200_000)]) {
    assert.throws(() => translateCodexHook(payload({ text }), options), /size|limit/i);
  }
  let nested = "leaf";
  for (let index = 0; index < 65; index += 1) nested = { nested };
  assert.throws(() => translateCodexHook(payload({ nested }), options), /depth|nesting|limit/i);
  assert.throws(() => translateCodexHook(payload({ values: Array(65_536).fill(0) }), options), /values|limit/i);
});

test("Codex validates identifiers, key and time without mutating its inputs", () => {
  for (const field of ["session_id", "turn_id", "cwd", "tool_name", "tool_use_id"]) {
    for (const value of ["", " ", null, 7]) {
      assert.throws(() => translateCodexHook(payload({ [field]: value }), options), new RegExp(field));
    }
  }
  for (const occurrenceID of ["", " ", null, 7]) {
    assert.throws(() => translateCodexHook(payload(), { ...options, occurrenceID }), /occurrenceID/);
  }
  for (const key of [undefined, "text", Buffer.alloc(31), new Uint8Array(32)]) {
    assert.throws(() => translateCodexHook(payload(), { ...options, authKey: key }), /authKey/);
  }
  assert.throws(() => translateCodexHook(payload(), { ...options, now: "invalid" }), /time|date/i);
  const input = payload();
  const before = structuredClone(input);
  const event = translateCodexHook(input, options);
  assert.deepEqual(input, before);
  assert.notEqual(event.sessionHMAC, createHash("sha256").update(input.session_id).digest("hex"));
  assert.notEqual(event.sessionHMAC, translateCodexHook(input, { ...options, authKey: Buffer.alloc(32, 0x64) }).sessionHMAC);
});
