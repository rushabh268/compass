import { isolateCompassEnvironment } from "../../helpers/compass-environment.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEventCoalescer } from "../../../adapters/opencode/coalescer.mjs";
import { translateOpenCodeEvent, buildGroundingEvent } from "../../../adapters/opencode/translate.mjs";

const authKey = Buffer.alloc(32, 0x61);
const now = new Date("2026-08-24T12:34:56.000Z");
const restoreAliases = isolateCompassEnvironment();
test.after(restoreAliases);
const originalStateDir = process.env.COMPASS_STATE_DIR;
const originalCoalescingConfig = process.env.COMPASS_COALESCING_CONFIG;
const hermeticStateDir = mkdtempSync(join(tmpdir(), "ah-opencode-state-"));
process.env.COMPASS_STATE_DIR = hermeticStateDir;
delete process.env.COMPASS_COALESCING_CONFIG;
let environmentRestored = false;
function restoreEnvironment() {
  if (environmentRestored) return;
  environmentRestored = true;
  if (originalStateDir === undefined) delete process.env.COMPASS_STATE_DIR;
  else process.env.COMPASS_STATE_DIR = originalStateDir;
  if (originalCoalescingConfig === undefined) delete process.env.COMPASS_COALESCING_CONFIG;
  else process.env.COMPASS_COALESCING_CONFIG = originalCoalescingConfig;
  rmSync(hermeticStateDir, { recursive: true, force: true });
}
process.once("exit", restoreEnvironment);
test.after(restoreEnvironment);

test("translates v1 and v2 session shapes into a closed redacted envelope", () => {
  for (const input of [
    { type: "session.created", sessionID: "session-secret", id: "event-secret" },
    { type: "session.created", info: { id: "session-secret", parentID: "parent-secret" }, id: "event-secret" },
    { type: "session.created", part: { sessionID: "session-secret", text: "message-secret" }, id: "event-secret" },
  ]) {
    const event = translateOpenCodeEvent(input, {
      authKey, now, directory: "/secret/directory", worktree: "/secret/worktree",
    });
    assert.deepEqual(Object.keys(event).sort(), [
      "adapterVersion", "dedupeKey", "eventID", "eventType", "platform", "repoID", "runID",
      "schemaVersion", "sessionHMAC", "timestamp", "worktreeID",
      ...(input.info?.parentID ? ["parentSessionHMAC"] : []),
    ].sort());
    assert.equal(event.platform, "opencode");
    assert.equal(event.eventType, "SessionStart");
    assert.equal(event.timestamp, now.toISOString());
    assert.equal(Object.isFrozen(event), true);
    assert.equal(JSON.stringify(event).includes("secret"), false);
  }
});

test("canonicalizes tool lifecycle metadata and deduplicates native call IDs", () => {
  const input = { eventType: "tool.execute.before", sessionID: "session", tool: "bash", callID: "call-1" };
  const first = translateOpenCodeEvent(input, { authKey, now, occurrenceID: "ignored-1" });
  const replay = translateOpenCodeEvent({ ...input }, { authKey, now, occurrenceID: "ignored-2" });
  assert.equal(first.eventType, "PreToolUse");
  assert.equal(first.toolName, "Bash");
  assert.match(first.callID, /^[0-9a-f]{64}$/);
  assert.equal(first.eventID, replay.eventID);
  assert.equal(first.dedupeKey, replay.dedupeKey);
  assert.equal(JSON.stringify(first).includes("call-1"), false);
});

test("adds an observe decision only when an OpenCode event payload contains synthetic secrets", () => {
  const sentinel = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const secret = translateOpenCodeEvent({
    id: "event-secret",
    type: "message.updated",
    properties: { info: { id: "message", sessionID: "session", text: sentinel } },
  }, { authKey, now });
  const nonsecret = translateOpenCodeEvent({
    id: "event-safe",
    type: "message.updated",
    properties: { info: { id: "message", sessionID: "session", text: "safe value" } },
  }, { authKey, now });

  assert.deepEqual(secret.decision, {
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  });
  assert.equal(JSON.stringify(secret).includes(sentinel), false);
  assert.equal(Object.hasOwn(nonsecret, "decision"), false);
});

test("uses occurrence fallback and HMAC-labels unknown event and tool names", () => {
  const input = { type: "private.event.name", sessionID: "session", tool: "private-tool" };
  const one = translateOpenCodeEvent(input, { authKey, now, occurrenceID: "one" });
  const two = translateOpenCodeEvent(input, { authKey, now, occurrenceID: "two" });
  assert.match(one.eventType, /^[0-9a-f]{64}$/);
  assert.match(one.toolName, /^[0-9a-f]{64}$/);
  assert.notEqual(one.eventID, two.eventID);
  assert.equal(JSON.stringify(one).includes("private"), false);
});

test("links parent sessions in the same session HMAC domain", () => {
  const parent = translateOpenCodeEvent({ type: "session.created", info: { id: "parent" } }, { authKey, now, occurrenceID: "p" });
  const child = translateOpenCodeEvent({ type: "session.created", info: { id: "child", parentID: "parent" } }, { authKey, now, occurrenceID: "c" });
  assert.equal(child.parentSessionHMAC, parent.sessionHMAC);
});

test("translates a sessionless session.error into the global StopFailure stream", () => {
  const failure = translateOpenCodeEvent({
    type: "session.error",
    id: "session-error-without-session",
    error: { name: "ProviderError", message: "sanitized" },
  }, { authKey, now });
  const global = translateOpenCodeEvent({ type: "file.edited", id: "global-event" }, { authKey, now });

  assert.equal(failure.eventType, "StopFailure");
  assert.equal(failure.runID, global.runID);
  assert.equal(failure.sessionHMAC, global.sessionHMAC);
  assert.equal(Object.hasOwn(failure, "decision"), false);
});

test("RED: global metrics and sessionless global DLP IDs differ across injected retention epochs", async () => {
  const secret = "Authorization: Bearer b7Qx_2mN9-vR4.kL8sP0";
  const sessionless = {
    type: "session.error",
    id: "same-global-dlp-event",
    error: { name: "ProviderError", message: secret },
  };
  const firstDLP = translateOpenCodeEvent(sessionless, { authKey, now, retentionEpoch: "epoch-a" });
  const secondDLP = translateOpenCodeEvent(sessionless, { authKey, now, retentionEpoch: "epoch-b" });
  assert.ok(firstDLP.decision);
  assert.ok(secondDLP.decision);
  assert.notEqual(firstDLP.eventID, secondDLP.eventID, "sessionless global DLP event IDs must be epoch-scoped");
  assert.notEqual(firstDLP.dedupeKey, secondDLP.dedupeKey, "sessionless global DLP dedupe IDs must be epoch-scoped");

  async function globalMetric(retentionEpoch) {
    const emitted = [];
    const coalescer = createEventCoalescer({
      authKey,
      now: () => now,
      retentionEpoch,
      enqueue: (event) => { emitted.push(event); return true; },
    });
    coalescer.push(translateOpenCodeEvent({ type: "file.edited", id: "same-global-noise" }, {
      authKey, now, retentionEpoch,
    }));
    await coalescer.dispose();
    return emitted.find(({ eventType }) => eventType === "HarnessMetrics");
  }

  const firstMetric = await globalMetric("epoch-a");
  const secondMetric = await globalMetric("epoch-b");
  assert.notEqual(firstMetric.eventID, secondMetric.eventID, "global metric event IDs must be epoch-scoped");
  assert.notEqual(firstMetric.dedupeKey, secondMetric.dedupeKey, "global metric dedupe IDs must be epoch-scoped");
});

test("translates OpenCode 1.18.20 event envelopes with session linkage", async (t) => {
  const sessionID = "session-secret";
  const expectedSession = translateOpenCodeEvent(
    { type: "session.created", sessionID },
    { authKey, now, occurrenceID: "session-baseline" },
  );
  const cases = [
    ["session.status", "SessionStatus", { sessionID, status: { type: "busy" } }],
    ["session.idle", "Stop", { sessionID }],
    ["session.compacted", "PostCompact", { sessionID }],
    ["session.diff", "SessionDiff", { sessionID, diff: [] }],
    ["message.updated", "MessageUpdate", { info: {
      id: "message-1", sessionID, role: "user", time: { created: 1 },
      agent: "build", model: { providerID: "provider", modelID: "model" },
    } }],
    ["message.removed", "MessageRemove", { sessionID, messageID: "message-1" }],
    ["message.part.updated", "MessagePartUpdate", { part: { id: "part-1", sessionID, messageID: "message-1", type: "text", text: "secret" } }],
    ["message.part.removed", "MessagePartRemove", { sessionID, messageID: "message-1", partID: "part-1" }],
    ["permission.updated", "PermissionRequest", { id: "permission-1", sessionID, messageID: "message-1", type: "bash", title: "secret", metadata: {}, time: { created: 1 } }],
    ["permission.replied", "PermissionResponse", { sessionID, permissionID: "permission-1", response: "once" }],
    ["todo.updated", "TodoUpdate", { sessionID, todos: [{ id: "todo-1", content: "secret", status: "pending", priority: "high" }] }],
    ["command.executed", "CommandExecute", { sessionID, name: "test", arguments: "secret", messageID: "message-1" }],
  ];

  for (const [type, eventType, properties] of cases) {
    await t.test(type, () => {
      const event = translateOpenCodeEvent({ id: `event-${type}`, type, properties }, { authKey, now });
      assert.equal(event.eventType, eventType);
      assert.equal(event.runID, expectedSession.runID);
      assert.equal(event.sessionHMAC, expectedSession.sessionHMAC);
    });
  }
});

test("uses distinct top-level OpenCode event IDs as distinct identities", () => {
  const properties = { info: {
    id: "message-1", sessionID: "session-secret", role: "user", time: { created: 1 },
    agent: "build", model: { providerID: "provider", modelID: "model" },
  } };
  const first = translateOpenCodeEvent({ id: "event-1", type: "message.updated", properties }, { authKey, now });
  const second = translateOpenCodeEvent({ id: "event-2", type: "message.updated", properties }, { authKey, now });
  assert.notEqual(first.eventID, second.eventID);
  assert.notEqual(first.dedupeKey, second.dedupeKey);
});

test("uses occurrenceID when only properties.id is present", () => {
  const input = {
    type: "permission.updated",
    properties: {
      id: "permission-1", sessionID: "session-secret", messageID: "message-1",
      type: "bash", title: "secret", metadata: {}, time: { created: 1 },
    },
  };
  const first = translateOpenCodeEvent(input, { authKey, now, occurrenceID: "occurrence-1" });
  const second = translateOpenCodeEvent(input, { authKey, now, occurrenceID: "occurrence-2" });
  assert.notEqual(first.eventID, second.eventID);
  assert.notEqual(first.dedupeKey, second.dedupeKey);
});

test("rejects proxies, accessors, non-JSON values, and oversized payloads", () => {
  const accessor = { type: "session.created", sessionID: "session" };
  Object.defineProperty(accessor, "message", { enumerable: true, get() { assert.fail("accessor executed"); } });
  const cyclic = { type: "session.created", sessionID: "session" };
  cyclic.self = cyclic;
  for (const input of [
    new Proxy({ type: "session.created", sessionID: "session" }, {}), accessor, cyclic,
    { type: "session.created", sessionID: "session", value: undefined },
    { type: "session.created", sessionID: "session", value: 1n },
    { type: "session.created", sessionID: "session", value: new Date() },
    { type: "session.created", sessionID: "session", value: "x".repeat(1024 * 1024) },
  ]) assert.throws(() => translateOpenCodeEvent(input, { authKey, now }), /JSON|plain|size|payload/i);
});

test("buildGroundingEvent produces a valid GroundingInjection event with platform opencode", () => {
  const metadata = {
    sources: [{ kind: "project-notes", ref: "config/schema.json" }],
    bytes: 256,
    approxTokens: 64,
    matchReason: "ticket",
    commentFiles: 1,
    latencyMs: 20,
  };

  const event = buildGroundingEvent(metadata, { now, hmacKey: authKey });

  assert.equal(event.eventType, "GroundingInjection");
  assert.equal(event.platform, "opencode");
  assert.equal(event.schemaVersion, 1);
  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.metadata), true);
  assert.deepEqual(event.metadata, metadata);
});

test("buildGroundingEvent generates consistent identity via HMAC", () => {
  const metadata = {
    sources: [{ kind: "repo-comment", ref: "docs/notes.md" }],
    bytes: 512,
    approxTokens: 128,
    matchReason: "branch-folder-overlap",
    commentFiles: 2,
    latencyMs: 45,
  };

  const event1 = buildGroundingEvent(metadata, { now, hmacKey: authKey });
  const event2 = buildGroundingEvent(metadata, { now, hmacKey: authKey });

  assert.equal(event1.eventID, event2.eventID);
  assert.equal(event1.dedupeKey, event2.dedupeKey);
  assert.match(event1.sessionHMAC, /^[0-9a-f]{64}$/);
  assert.match(event1.runID, /^[0-9a-f]{64}$/);
});

test("buildGroundingEvent round-trips cleanly through JSON", () => {
  const metadata = {
    sources: [
      { kind: "project-notes", ref: "vault/api.md" },
      { kind: "repo-comment", ref: "comments/thread-1.md" },
    ],
    bytes: 1024,
    approxTokens: 256,
    matchReason: "none",
    commentFiles: 0,
    latencyMs: 100,
  };

  const event = buildGroundingEvent(metadata, { now, hmacKey: authKey });
  const serialized = JSON.stringify(event);
  const deserialized = JSON.parse(serialized);

  assert.deepEqual(deserialized, {
    schemaVersion: event.schemaVersion,
    eventID: event.eventID,
    runID: event.runID,
    platform: event.platform,
    sessionHMAC: event.sessionHMAC,
    eventType: event.eventType,
    timestamp: event.timestamp,
    dedupeKey: event.dedupeKey,
    metadata,
  });
});

test("buildGroundingEvent metadata contains NO raw text, brief, or vault/comment sentinels", () => {
  const metadata = {
    sources: [{ kind: "project-notes", ref: "some/path/file.md" }],
    bytes: 100,
    approxTokens: 25,
    matchReason: "ticket",
    commentFiles: 0,
    latencyMs: 10,
  };

  const event = buildGroundingEvent(metadata, { now, hmacKey: authKey });
  const serialized = JSON.stringify(event);

  // Ensure no raw content leaks
  for (const forbidden of ["brief:", "rawBrief", "rawContent", "briefContent", "@@VAULT@@"]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `buildGroundingEvent must not include ${forbidden}`,
    );
  }

  // Verify only closed metadata survives serialization
  assert.deepEqual(event.metadata, metadata);
});

test("buildGroundingEvent rejects metadata with unknown fields", () => {
  const invalidMetadata = {
    sources: [{ kind: "project-notes", ref: "file.md" }],
    bytes: 100,
    approxTokens: 25,
    matchReason: "none",
    commentFiles: 0,
    latencyMs: 5,
    rawText: "secret brief content",
  };

  assert.throws(
    () => buildGroundingEvent(invalidMetadata, { now, hmacKey: authKey }),
    /unknown.*metadata|not allowed/i,
  );
});

test("buildGroundingEvent uses consistent labels matching OpenCode event patterns", () => {
  const metadata = {
    sources: [{ kind: "project-notes", ref: "config/file.json" }],
    bytes: 200,
    approxTokens: 50,
    matchReason: "ticket",
    commentFiles: 1,
    latencyMs: 15,
  };

  const event = buildGroundingEvent(metadata, { now, hmacKey: authKey });

  // sessionHMAC should be HMAC-based label (64-hex digest)
  assert.match(event.sessionHMAC, /^[0-9a-f]{64}$/);
  // runID should be HMAC-based (consistent)
  assert.match(event.runID, /^[0-9a-f]{64}$/);
  // eventID should differ from dedupeKey
  assert.notEqual(event.eventID, event.dedupeKey);
});

// RED tests for retentionEpoch scoping in buildGroundingEvent

test("RED: buildGroundingEvent with retentionEpoch yields runID distinct from no-epoch case", () => {
  const metadata = {
    sources: [{ kind: "project-notes", ref: "config/schema.json" }],
    bytes: 256,
    approxTokens: 64,
    matchReason: "ticket",
    commentFiles: 1,
    latencyMs: 20,
  };

  const eventNoEpoch = buildGroundingEvent(metadata, { now, hmacKey: authKey });
  const eventWithEpoch = buildGroundingEvent(metadata, { now, hmacKey: authKey, retentionEpoch: "2026-08" });

  assert.notEqual(
    eventWithEpoch.runID,
    eventNoEpoch.runID,
    "retentionEpoch must scope runID so different epochs produce different run identities"
  );
});

test("RED: buildGroundingEvent with retentionEpoch yields eventID distinct from no-epoch case", () => {
  const metadata = {
    sources: [{ kind: "repo-comment", ref: "docs/notes.md" }],
    bytes: 512,
    approxTokens: 128,
    matchReason: "branch-folder-overlap",
    commentFiles: 2,
    latencyMs: 45,
  };

  const eventNoEpoch = buildGroundingEvent(metadata, { now, hmacKey: authKey });
  const eventWithEpoch = buildGroundingEvent(metadata, { now, hmacKey: authKey, retentionEpoch: "2026-09" });

  assert.notEqual(
    eventWithEpoch.eventID,
    eventNoEpoch.eventID,
    "retentionEpoch must scope eventID so archived epochs don't collide with later runs"
  );
  assert.notEqual(
    eventWithEpoch.dedupeKey,
    eventNoEpoch.dedupeKey,
    "retentionEpoch must scope dedupeKey for dedupe isolation"
  );
});

test("RED: buildGroundingEvent retentionEpoch parameter accepts string (or undefined)", () => {
  const metadata = {
    sources: [{ kind: "project-notes", ref: "vault/api.md" }],
    bytes: 1024,
    approxTokens: 256,
    matchReason: "none",
    commentFiles: 0,
    latencyMs: 100,
  };

  // Should accept undefined (backwards compat)
  const eventUndefined = buildGroundingEvent(metadata, { now, hmacKey: authKey, retentionEpoch: undefined });
  assert.ok(eventUndefined.eventID, "retentionEpoch=undefined must produce valid event");

  // Should accept string
  const eventWithString = buildGroundingEvent(metadata, { now, hmacKey: authKey, retentionEpoch: "2026-08" });
  assert.ok(eventWithString.eventID, "retentionEpoch=string must produce valid event");

  // Both should produce different eventIDs
  assert.notEqual(eventUndefined.eventID, eventWithString.eventID);
});

test("default global identities rotate by observation month while session identities remain stable", () => {
  for (const type of ["lsp.updated", "session.error", "session.created"]) {
    const input = { type, id: "same-native-occurrence", ...(type === "session.created" ? { info: { id: "session" } } : {}) };
    const first = translateOpenCodeEvent(input, { authKey, now: new Date("2026-09-30T23:59:59Z") });
    const second = translateOpenCodeEvent(input, { authKey, now: new Date("2026-10-01T00:00:00Z") });
    if (type === "session.created") assert.equal(first.runID, second.runID);
    else { assert.notEqual(first.runID, second.runID); assert.notEqual(first.eventID, second.eventID); }
  }
});
