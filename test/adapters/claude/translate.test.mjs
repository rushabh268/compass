import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { translateClaudeHook } from "../../../adapters/claude/translate.mjs";

const authKey = Buffer.alloc(32, 0x71);
const now = new Date("2026-08-24T12:34:56.000Z");
const supportedHookEvents = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "ConfigChange",
  "WorktreeCreate", "WorktreeRemove", "TaskCompleted", "TeammateIdle",
];

function payload(overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "native-session",
    cwd: "/private/repository",
    tool_name: "Bash",
    tool_input: { command: "printf TOP-SECRET" },
    prompt: "TOP-SECRET-PROMPT",
    transcript_path: "/private/transcript.jsonl",
    ...overrides,
  };
}

test("translates a Claude hook into a deterministic closed event envelope", () => {
  const input = payload({ agent_id: "native-agent", parent_session_id: "native-parent" });
  const first = translateClaudeHook(input, { authKey, now });
  const second = translateClaudeHook({ ...input }, { authKey, now });

  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), [
    "adapterVersion", "dedupeKey", "eventID", "eventType", "parentSessionHMAC", "platform",
    "runID", "schemaVersion", "sessionHMAC", "timestamp", "toolName", "worktreeID",
  ].sort());
  assert.equal(first.platform, "claude");
  assert.equal(first.adapterVersion, "1");
  assert.equal(first.eventType, "PreToolUse");
  assert.equal(first.timestamp, now.toISOString());
  assert.equal(first.toolName, "Bash");
  for (const field of ["runID", "sessionHMAC", "parentSessionHMAC", "worktreeID", "eventID", "dedupeKey"]) {
    assert.match(first[field], /^[0-9a-f]{64}$/);
  }
  assert.notEqual(first.runID, first.sessionHMAC);
  assert.notEqual(first.eventID, first.dedupeKey);

  const serialized = JSON.stringify(first);
  for (const secret of ["native-session", "native-agent", "native-parent", "/private/repository", "TOP-SECRET", "transcript.jsonl", "printf"]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
});

test("translates every supported Claude hook event unchanged", () => {
  for (const eventType of supportedHookEvents) {
    const event = translateClaudeHook(payload({ hook_event_name: eventType, ...(["SubagentStart", "SubagentStop"].includes(eventType) ? { agent_id: "synthetic-agent" } : {}) }), { authKey, now });
    assert.equal(event.eventType, eventType);
  }
});

test("rejects unknown hook event names without exposing them", () => {
  const secretEventName = "Unknown-customer-secret-token";
  assert.throws(
    () => translateClaudeHook(payload({ hook_event_name: secretEventName }), { authKey, now }),
    /hook_event_name|event/i,
  );
});

test("uses native tool IDs for deterministic replay and occurrence IDs for repeated non-tool hooks", () => {
  const tool = payload({ tool_use_id: "native-tool-use" });
  const first = translateClaudeHook(tool, { authKey, now, occurrenceID: "ignored-one" });
  const replay = translateClaudeHook({ ...tool }, { authKey, now, occurrenceID: "ignored-two" });
  assert.equal(first.eventID, replay.eventID);
  assert.equal(first.dedupeKey, replay.dedupeKey);

  const nonTool = payload({ hook_event_name: "UserPromptSubmit" });
  delete nonTool.tool_name;
  delete nonTool.tool_input;
  const one = translateClaudeHook(nonTool, { authKey, now, occurrenceID: "occurrence-one" });
  const two = translateClaudeHook(nonTool, { authKey, now, occurrenceID: "occurrence-two" });
  assert.notEqual(one.eventID, two.eventID);
  assert.notEqual(one.dedupeKey, two.dedupeKey);
});

test("scopes Claude tool identities to the lifecycle event", () => {
  const pre = payload({ hook_event_name: "PreToolUse", tool_use_id: "native-tool-use" });
  const post = payload({ hook_event_name: "PostToolUse", tool_use_id: "native-tool-use" });

  const translatedPre = translateClaudeHook(pre, { authKey, now });
  const replayedPre = translateClaudeHook({ ...pre }, { authKey, now });
  const translatedPost = translateClaudeHook(post, { authKey, now });
  const replayedPost = translateClaudeHook({ ...post }, { authKey, now });

  assert.equal(translatedPre.eventID, replayedPre.eventID);
  assert.equal(translatedPre.dedupeKey, replayedPre.dedupeKey);
  assert.equal(translatedPost.eventID, replayedPost.eventID);
  assert.equal(translatedPost.dedupeKey, replayedPost.dedupeKey);
  assert.notEqual(translatedPre.eventID, translatedPost.eventID);
  assert.notEqual(translatedPre.dedupeKey, translatedPost.dedupeKey);
});

test("adds an observe decision only when a Claude payload contains synthetic secrets", () => {
  const sentinel = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const secret = translateClaudeHook(payload({ tool_input: { command: sentinel } }), { authKey, now });
  const nonsecret = translateClaudeHook(payload({
    tool_input: { command: "printf safe-value" },
    prompt: "safe prompt",
  }), { authKey, now });

  assert.deepEqual(secret.decision, {
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  });
  assert.equal(JSON.stringify(secret).includes(sentinel), false);
  assert.equal(Object.hasOwn(nonsecret, "decision"), false);
});

test("uses occurrence IDs for identical tool hooks without native tool IDs", () => {
  const input = payload();
  const first = translateClaudeHook(input, { authKey, now, occurrenceID: "occurrence-one" });
  const second = translateClaudeHook({ ...input }, { authKey, now, occurrenceID: "occurrence-two" });

  assert.notEqual(first.eventID, second.eventID);
  assert.notEqual(first.dedupeKey, second.dedupeKey);
});

test("preserves canonical Claude tool names and HMAC-labels unknown names", () => {
  for (const toolName of ["Bash", "Edit", "Glob", "Grep", "Read", "Task", "WebFetch", "WebSearch", "Write"]) {
    assert.equal(translateClaudeHook(payload({ tool_name: toolName }), { authKey, now }).toolName, toolName);
  }

  const secretToolName = "customer-secret-plugin-token";
  const event = translateClaudeHook(payload({ tool_name: secretToolName }), { authKey, now });
  assert.match(event.toolName, /[0-9a-f]{64}/);
  assert.equal(event.toolName.includes(secretToolName), false);
  assert.equal(JSON.stringify(event).includes(secretToolName), false);
});

test("uses the same session HMAC domain for parent session and parent agent IDs", () => {
  const parentPayload = payload({ session_id: "shared-native-parent" });
  delete parentPayload.tool_name;
  const parent = translateClaudeHook(parentPayload, { authKey, now });
  const bySession = translateClaudeHook(payload({ parent_session_id: "shared-native-parent" }), { authKey, now });
  const byAgent = translateClaudeHook(payload({ parent_agent_id: "shared-native-parent" }), { authKey, now });

  assert.equal(bySession.parentSessionHMAC, parent.sessionHMAC);
  assert.equal(byAgent.parentSessionHMAC, parent.sessionHMAC);
});

test("fingerprints an own JSON __proto__ field without changing object prototypes", () => {
  const first = JSON.parse('{"hook_event_name":"SessionStart","session_id":"session","__proto__":{"value":1}}');
  const changed = JSON.parse('{"hook_event_name":"SessionStart","session_id":"session","__proto__":{"value":2}}');
  const one = translateClaudeHook(first, { authKey, now });
  const two = translateClaudeHook(changed, { authKey, now });

  assert.notEqual(one.eventID, two.eventID);
  assert.equal(Object.getPrototypeOf(first), Object.prototype);
  assert.equal(Object.getPrototypeOf(changed), Object.prototype);
});

test("omits optional fields when native values are absent", () => {
  const event = translateClaudeHook({ hook_event_name: "SessionStart", session_id: "session" }, { authKey, now });
  assert.deepEqual(Object.keys(event).sort(), [
    "adapterVersion", "dedupeKey", "eventID", "eventType", "platform", "runID", "schemaVersion",
    "sessionHMAC", "timestamp",
  ].sort());
});

test("rejects proxies, accessors, non-JSON values, invalid keys, and oversized payloads", () => {
  const accessor = payload();
  Object.defineProperty(accessor, "prompt", { enumerable: true, get() { assert.fail("accessor executed"); } });
  const cases = [
    new Proxy(payload(), {}),
    accessor,
    payload({ value: undefined }),
    payload({ value: 1n }),
    payload({ value: Number.NaN }),
    payload({ value: () => {} }),
    payload({ value: Symbol("x") }),
    payload({ value: new Date() }),
    payload({ huge: "x".repeat(1024 * 1024) }),
  ];
  const cyclic = payload();
  cyclic.self = cyclic;
  cases.push(cyclic);

  for (const input of cases) assert.throws(() => translateClaudeHook(input, { authKey, now }), /JSON|plain|size|payload/i);
  assert.throws(() => translateClaudeHook(payload(), { authKey: Buffer.alloc(31), now }), /authKey/i);
});

test("uses HMAC-SHA256 rather than an unhashed native identifier", () => {
  const event = translateClaudeHook(payload(), { authKey, now });
  const rawDigest = createHmac("sha256", authKey).update("native-session").digest("hex");
  assert.notEqual(event.sessionHMAC, rawDigest, "identifiers must be domain separated");
});

test("incomplete child callbacks cannot be attributed to their parent", () => {
  for (const hook_event_name of ["SubagentStart", "SubagentStop"]) assert.throws(() => translateClaudeHook(payload({ hook_event_name }), { authKey, now }), /subject/);
});
