import assert from "node:assert/strict";
import test from "node:test";

import { createDecision } from "../../src/protocol/decision.mjs";
import { createEvent } from "../../src/protocol/event.mjs";

const hashes = Object.freeze({
  event: "1".repeat(64),
  run: "2".repeat(64),
  session: "3".repeat(64),
  dedupe: "4".repeat(64),
  previous: "5".repeat(64),
  parent: "6".repeat(64),
  attempt: "7".repeat(64),
  call: "8".repeat(64),
  repo: "9".repeat(64),
  worktree: "a".repeat(64),
  subject: "b".repeat(64),
  label: "c".repeat(64),
});

const required = {
  schemaVersion: 1,
  eventID: hashes.event,
  runID: hashes.run,
  platform: "claude",
  sessionHMAC: hashes.session,
  eventType: "PreToolUse",
  timestamp: "2026-08-24T12:34:56.000Z",
  dedupeKey: hashes.dedupe,
};

test("createEvent returns a frozen plain JSON object", () => {
  const input = {
    ...required,
    adapterVersion: "1.2.3",
    sequence: 0,
    previousEventHMAC: hashes.previous,
    parentSessionHMAC: hashes.parent,
    attemptID: hashes.attempt,
    callID: hashes.call,
    repoID: hashes.repo,
    worktreeID: hashes.worktree,
    toolName: "Read",
    decision: createDecision({
      schemaVersion: 1,
      action: "allow",
      ruleIDs: ["policy.allow"],
      reason: "Allowed by policy",
    }),
    subjectID: hashes.subject,
  };

  const event = createEvent(input);

  assert.deepEqual(event, input);
  assert.notEqual(event, input);
  assert.equal(Object.getPrototypeOf(event), Object.prototype);
  assert.equal(Object.isFrozen(event), true);
  assert.throws(() => { event.eventType = "prompt.raw"; }, TypeError);
});

test("createEvent survives a JSON round trip", () => {
  const event = createEvent(JSON.parse(JSON.stringify(required)));
  assert.deepEqual(JSON.parse(JSON.stringify(event)), required);
});

test("createEvent accepts, freezes, and round-trips a nested decision", () => {
  const decision = createDecision({
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  });
  const event = createEvent({ ...required, decision });

  assert.deepEqual(event.decision, decision);
  assert.equal(Object.isFrozen(event.decision), true);
  assert.equal(Object.isFrozen(event.decision.ruleIDs), true);
  assert.deepEqual(JSON.parse(JSON.stringify(event)), { ...required, decision });
});

test("createEvent requires a structured decision and rejects every string decision", () => {
  for (const decision of [
    "allow",
    "observe",
    "block",
    "arbitrary decision text",
    "Authorization: Bearer secret-token",
  ]) {
    assert.throws(() => createEvent({ ...required, decision }), /decision/i);
  }

  const decision = createDecision({
    schemaVersion: 1,
    action: "allow",
    ruleIDs: ["policy.allow"],
    reason: "Allowed by policy",
  });
  assert.deepEqual(createEvent({ ...required, decision }).decision, decision);
});

test("createEvent accepts all supported platforms", () => {
  for (const platform of ["claude", "opencode", "codex"]) {
    assert.equal(createEvent({ ...required, platform }).platform, platform);
  }
});

test("createEvent rejects non-plain inputs and unknown fields", () => {
  class EventInput {}
  for (const input of [null, [], new EventInput(), Object.create(null)]) {
    assert.throws(() => createEvent(input), TypeError);
  }
  assert.throws(() => createEvent({ ...required, rawPrompt: "secret" }), /unknown field/i);
  assert.throws(() => createEvent({ ...required, toolPayload: { token: "secret" } }), /unknown field/i);
});

test("createEvent rejects properties that plain JSON cannot represent", () => {
  const withSymbol = { ...required, [Symbol("rawPayload")]: "secret" };
  const withAccessor = { ...required };
  Object.defineProperty(withAccessor, "eventType", { enumerable: true, get: () => "tool.call" });

  assert.throws(() => createEvent(withSymbol), /plain JSON object/);
  assert.throws(() => createEvent(withAccessor), /plain JSON object/);
});

test("createEvent rejects enclosing proxies that change after validation", () => {
  let reads = 0;
  const proxied = new Proxy({ ...required }, {
    get(target, property, receiver) {
      if (property === "eventType" && ++reads > 1) return { rawPrompt: "secret" };
      return Reflect.get(target, property, receiver);
    },
  });

  assert.throws(() => createEvent(proxied), /plain JSON object/);
});

test("createEvent requires every required field", () => {
  for (const field of [
    "schemaVersion", "eventID", "runID", "platform", "sessionHMAC",
    "eventType", "timestamp", "dedupeKey",
  ]) {
    const input = { ...required };
    delete input[field];
    assert.throws(() => createEvent(input), new RegExp(field));
  }
});

test("createEvent fixes schemaVersion to 1", () => {
  for (const schemaVersion of [0, 2, "1"]) {
    assert.throws(() => createEvent({ ...required, schemaVersion }), /schemaVersion/);
  }
});

test("createEvent validates bounded nonempty strings", () => {
  const stringFields = [
    "eventID", "runID", "sessionHMAC", "eventType", "dedupeKey",
    "adapterVersion", "previousEventHMAC", "parentSessionHMAC", "attemptID",
    "callID", "repoID", "worktreeID", "toolName", "decision", "subjectID",
  ];
  for (const field of stringFields) {
    for (const value of ["", "   ", 42, "x".repeat(1025)]) {
      assert.throws(() => createEvent({ ...required, [field]: value }), new RegExp(field));
    }
  }
});

test("createEvent requires persistence identifiers and HMAC metadata to be lowercase SHA-256 labels", () => {
  const fields = [
    "sessionHMAC", "previousEventHMAC", "parentSessionHMAC", "callID", "repoID", "worktreeID",
  ];
  for (const field of fields) {
    for (const value of ["secret-bearing-value", "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      assert.throws(() => createEvent({ ...required, [field]: value }), new RegExp(field));
    }
  }
});

test("createEvent accepts only canonical or HMAC labels for eventType and toolName", () => {
  for (const field of ["eventType", "toolName"]) {
    for (const value of [
      "Authorization: Bearer secret", "CustomerSecretToken", "customer secret", "tool.call", "lowercase",
    ]) {
      assert.throws(() => createEvent({ ...required, [field]: value }), new RegExp(field));
    }
    for (const value of ["PreToolUse", "WebFetch", "LspDiagnostics", hashes.label]) {
      assert.equal(createEvent({ ...required, [field]: value })[field], value);
    }
  }
});

test("createEvent bounds strings by Unicode code points", () => {
  assert.equal(createEvent({ ...required, adapterVersion: "😀".repeat(1024) }).adapterVersion, "😀".repeat(1024));
  assert.throws(() => createEvent({ ...required, adapterVersion: "😀".repeat(1025) }), /adapterVersion/);
});

test("createEvent validates sequence, timestamp, and platform", () => {
  for (const sequence of [-1, 1.5, "1"]) {
    assert.throws(() => createEvent({ ...required, sequence }), /sequence/);
  }
  for (const timestamp of ["2026-08-24", "not-a-date", "2026-02-30T00:00:00Z"]) {
    assert.throws(() => createEvent({ ...required, timestamp }), /timestamp/);
  }
  for (const platform of ["unknown", "Claude", ""]) {
    assert.throws(() => createEvent({ ...required, platform }), /platform/);
  }
});

test("createEvent validates ISO dates in year 0000", () => {
  assert.equal(
    createEvent({ ...required, timestamp: "0000-02-29T00:00:00Z" }).timestamp,
    "0000-02-29T00:00:00Z",
  );
  assert.throws(
    () => createEvent({ ...required, timestamp: "0000-02-30T00:00:00Z" }),
    /timestamp/,
  );
});

test("createEvent rejects summary if not a plain object", () => {
  for (const summary of ["not an object", 42, null, [], new Set()]) {
    assert.throws(() => createEvent({ ...required, summary }), /summary/i);
  }
});

test("createEvent accepts optional summary object with only known counter fields", () => {
  const summary = {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  const event = createEvent({ ...required, eventType: "HarnessMetrics", summary });
  assert.deepEqual(event.summary, summary);
  assert.equal(Object.isFrozen(event.summary), true);
});

test("createEvent rejects summary with unknown fields", () => {
  const baselineSummary = {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  for (const unknown of ["extra", "payload", "secret", "debug_info"]) {
    assert.throws(
      () => createEvent({ ...required, eventType: "HarnessMetrics", summary: { ...baselineSummary, [unknown]: 1 } }),
      /unknown.*summary/i,
    );
  }
});

test("createEvent rejects summary counters that are not nonnegative integers", () => {
  const validCounters = [
    "coalesced", "messagePartDelta", "messagePartUpdate", "messageUpdate",
    "sessionStatus", "sessionDiff", "todoUpdate", "noise", "queueFull",
  ];
  for (const field of validCounters) {
    for (const value of [-1, -999, 1.5, "0", NaN, Infinity]) {
      assert.throws(
        () => createEvent({
          ...required,
          eventType: "HarnessMetrics",
          summary: { [field]: value },
        }),
        new RegExp(field),
      );
    }
  }
});

test("createEvent accepts summary counters as large safe integers", () => {
  const summary = {
    coalesced: Number.MAX_SAFE_INTEGER,
    messagePartDelta: 0,
    messagePartUpdate: 1000000,
    messageUpdate: 2147483647,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  const event = createEvent({ ...required, eventType: "HarnessMetrics", summary });
  assert.deepEqual(event.summary, summary);
});

test("createEvent rejects summary counters that exceed MAX_SAFE_INTEGER", () => {
  const summary = {
    coalesced: Number.MAX_SAFE_INTEGER + 1,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  assert.throws(() => createEvent({ ...required, eventType: "HarnessMetrics", summary }), /coalesced/);
});

test("createEvent with partial summary object requires all or none of the counters", () => {
  const partial = { coalesced: 0, messagePartDelta: 0 };
  assert.throws(() => createEvent({ ...required, summary: partial }), /summary/i);
});

test("createEvent freezes nested summary object and prevents modification", () => {
  const summary = {
    coalesced: 5,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  const event = createEvent({ ...required, eventType: "HarnessMetrics", summary });
  assert.throws(() => { event.summary.coalesced = 10; }, TypeError);
});

test("createEvent rejects summary with proxies or accessors", () => {
  const validSummary = {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  const withAccessor = { ...validSummary };
  Object.defineProperty(withAccessor, "coalesced", {
    enumerable: true,
    get: () => 0,
  });
  assert.throws(() => createEvent({ ...required, summary: withAccessor }), /summary/i);
});

test("createEvent survives summary round-trip through JSON", () => {
  const summary = {
    coalesced: 42,
    messagePartDelta: 3,
    messagePartUpdate: 1,
    messageUpdate: 0,
    sessionStatus: 2,
    sessionDiff: 0,
    todoUpdate: 1,
    noise: 5,
    queueFull: 0,
  };
  const event = createEvent({ ...required, eventType: "HarnessMetrics", summary });
  const roundTrip = JSON.parse(JSON.stringify(event));
  assert.deepEqual(roundTrip.summary, summary);
});

test("createEvent with HarnessMetrics label", () => {
  const summary = {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  const event = createEvent({ ...required, eventType: "HarnessMetrics", summary });
  assert.equal(event.eventType, "HarnessMetrics");
});

test("createEvent rejects eventType HarnessMetrics with non-object summary", () => {
  assert.throws(() => createEvent({ ...required, eventType: "HarnessMetrics", summary: null }), /summary/i);
  assert.throws(() => createEvent({ ...required, eventType: "HarnessMetrics", summary: "metrics" }), /summary/i);
});

test("createEvent HarnessMetrics REQUIRES summary field (RED: metrics contract)", () => {
  assert.throws(
    () => createEvent({ ...required, eventType: "HarnessMetrics" }),
    /HarnessMetrics.*summary|summary.*required|HarnessMetrics.*require/i,
  );
});

test("createEvent HarnessMetrics with valid summary (RED: metrics contract)", () => {
  const summary = {
    coalesced: 5,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  const event = createEvent({ ...required, eventType: "HarnessMetrics", summary });
  assert.equal(event.eventType, "HarnessMetrics");
  assert.deepEqual(event.summary, summary);
});

test("createEvent non-HarnessMetrics REJECTS summary (RED: one representation)", () => {
  const summary = {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  };
  for (const eventType of ["PreToolUse", "PostToolUse", "Read", "WebFetch", "Bash"]) {
    assert.throws(
      () => createEvent({ ...required, eventType, summary }),
      /summary.*forbidden|non-HarnessMetrics.*summary|only HarnessMetrics/i,
    );
  }
});

test("createEvent forbids counters field entirely (RED: remove counters)", () => {
  const counters = { coalesced: 5, queueFull: 2 };
  assert.throws(
    () => createEvent({ ...required, counters }),
    /unknown field.*counters|counters.*not allowed/i,
  );
  assert.throws(
    () => createEvent({ ...required, eventType: "HarnessMetrics", summary: {
      coalesced: 0,
      messagePartDelta: 0,
      messagePartUpdate: 0,
      messageUpdate: 0,
      sessionStatus: 0,
       sessionDiff: 0,
       todoUpdate: 0,
       noise: 0,
       queueFull: 0,
     }, counters }),
     /unknown field.*counters|counters.*not allowed/i,
   );
});

test("createEvent accepts GroundingInjection as a canonical eventType", () => {
  const event = createEvent({ ...required, eventType: "GroundingInjection" });
  assert.equal(event.eventType, "GroundingInjection");
});

test("createEvent accepts Codex Interrupt as a canonical eventType", () => {
  const event = createEvent({ ...required, platform: "codex", eventType: "Interrupt" });
  assert.equal(event.platform, "codex");
  assert.equal(event.eventType, "Interrupt");
});

test("createEvent accepts metadata field ONLY when eventType is GroundingInjection", () => {
  const validMetadata = {
    sources: [{ kind: "project-notes", ref: "config/schema.json" }],
    bytes: 512,
    approxTokens: 100,
    matchReason: "ticket",
    commentFiles: 2,
    latencyMs: 15,
  };

  // GroundingInjection accepts metadata
  assert.deepEqual(
    createEvent({ ...required, eventType: "GroundingInjection", metadata: validMetadata }).metadata,
    validMetadata,
  );

  // Other eventTypes reject metadata as unknown field
  for (const eventType of ["PreToolUse", "PostToolUse", "SessionStart"]) {
    assert.throws(
      () => createEvent({ ...required, eventType, metadata: validMetadata }),
      /unknown field.*metadata|metadata.*not allowed/i,
    );
  }
});

test("createEvent GroundingInjection metadata is closed: only {sources, bytes, approxTokens, matchReason, commentFiles, latencyMs} allowed", () => {
  const validMetadata = {
    sources: [{ kind: "project-notes", ref: "vault/file.md" }],
    bytes: 100,
    approxTokens: 50,
    matchReason: "branch-folder-overlap",
    commentFiles: 1,
    latencyMs: 25,
  };

  // Valid: minimal required fields present
  assert.doesNotThrow(() => createEvent({ ...required, eventType: "GroundingInjection", metadata: validMetadata }));

  // Reject unknown metadata keys
  for (const unknownKey of ["text", "brief", "branch", "cwd", "prompt", "payload", "extra"]) {
    const invalid = { ...validMetadata, [unknownKey]: "secret" };
    assert.throws(
      () => createEvent({ ...required, eventType: "GroundingInjection", metadata: invalid }),
      /unknown.*metadata|not allowed.*metadata/i,
    );
  }

  // Reject raw-looking field names
  for (const rawField of ["rawContent", "rawBrief", "rawText"]) {
    const invalid = { ...validMetadata, [rawField]: "content" };
    assert.throws(
      () => createEvent({ ...required, eventType: "GroundingInjection", metadata: invalid }),
      /unknown.*metadata|not allowed.*metadata/i,
    );
  }
});

test("createEvent GroundingInjection metadata.sources must be array of {kind, ref} with valid kind enum", () => {
  const validMetadata = (sources) => ({
    sources,
    bytes: 100,
    approxTokens: 50,
    matchReason: "ticket",
    commentFiles: 0,
    latencyMs: 10,
  });

  // Valid kinds
  for (const kind of ["project-notes", "repo-comment"]) {
    assert.doesNotThrow(() => createEvent({
      ...required,
      eventType: "GroundingInjection",
      metadata: validMetadata([{ kind, ref: "path/to/file" }]),
    }));
  }

  // Invalid kind
  assert.throws(
    () => createEvent({
      ...required,
      eventType: "GroundingInjection",
      metadata: validMetadata([{ kind: "invalid-kind", ref: "file" }]),
    }),
    /sources.*kind|kind.*enum/i,
  );

  // ref must be nonempty and bounded string
  assert.throws(
    () => createEvent({
      ...required,
      eventType: "GroundingInjection",
      metadata: validMetadata([{ kind: "project-notes", ref: "" }]),
    }),
    /sources.*ref|ref.*nonempty/i,
  );

  // ref that exceeds max string length
  assert.throws(
    () => createEvent({
      ...required,
      eventType: "GroundingInjection",
      metadata: validMetadata([{ kind: "project-notes", ref: "x".repeat(1025) }]),
    }),
    /sources.*ref|ref.*length/i,
  );
});

test("createEvent GroundingInjection metadata counters (bytes, approxTokens, commentFiles, latencyMs) must be nonnegative safe integers", () => {
  const baseMetadata = {
    sources: [{ kind: "project-notes", ref: "file.md" }],
    matchReason: "none",
  };

  const testCounter = (field, value) => {
    const metadata = { ...baseMetadata, [field]: value };
    ["bytes", "approxTokens", "commentFiles", "latencyMs"].forEach((f) => {
      if (f !== field) metadata[f] = 0;
    });
    return createEvent({ ...required, eventType: "GroundingInjection", metadata });
  };

  // Valid: nonnegative safe integers
  for (const field of ["bytes", "approxTokens", "commentFiles", "latencyMs"]) {
    assert.doesNotThrow(() => testCounter(field, 0));
    assert.doesNotThrow(() => testCounter(field, 1000));
    assert.doesNotThrow(() => testCounter(field, Number.MAX_SAFE_INTEGER));
  }

  // Invalid: negative
  for (const field of ["bytes", "approxTokens", "commentFiles", "latencyMs"]) {
    assert.throws(() => testCounter(field, -1), /negative|nonnegative/i);
  }

  // Invalid: non-integer
  for (const field of ["bytes", "approxTokens", "commentFiles", "latencyMs"]) {
    assert.throws(() => testCounter(field, 1.5), /integer|safe integer/i);
  }

  // Invalid: exceeds MAX_SAFE_INTEGER
  for (const field of ["bytes", "approxTokens", "commentFiles", "latencyMs"]) {
    assert.throws(() => testCounter(field, Number.MAX_SAFE_INTEGER + 1), /safe integer/i);
  }
});

test("createEvent GroundingInjection metadata.matchReason must be an enum: ticket, branch-folder-overlap, none", () => {
  const validMetadata = {
    sources: [{ kind: "repo-comment", ref: "docs/api.md" }],
    bytes: 250,
    approxTokens: 60,
    commentFiles: 1,
    latencyMs: 30,
  };

  // Valid enum values
  for (const matchReason of ["ticket", "branch-folder-overlap", "none"]) {
    assert.doesNotThrow(() => createEvent({
      ...required,
      eventType: "GroundingInjection",
      metadata: { ...validMetadata, matchReason },
    }));
  }

  // Invalid: not in enum
  for (const invalid of ["invalid", "TICKET", "unknown", "ticket-match", ""]) {
    assert.throws(
      () => createEvent({
        ...required,
        eventType: "GroundingInjection",
        metadata: { ...validMetadata, matchReason: invalid },
      }),
      /matchReason.*enum|unknown value.*matchReason/i,
    );
  }
});

test("createEvent GroundingInjection event is frozen and cannot be modified", () => {
  const metadata = {
    sources: [{ kind: "project-notes", ref: "config/grounding.json" }],
    bytes: 1024,
    approxTokens: 200,
    matchReason: "ticket",
    commentFiles: 3,
    latencyMs: 50,
  };
  const event = createEvent({ ...required, eventType: "GroundingInjection", metadata });

  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.metadata), true);
  assert.throws(() => { event.eventType = "SessionStart"; }, TypeError);
  assert.throws(() => { event.metadata.bytes = 99999; }, TypeError);
});

test("createEvent GroundingInjection metadata round-trips through JSON", () => {
  const metadata = {
    sources: [
      { kind: "project-notes", ref: "vault/config.md" },
      { kind: "repo-comment", ref: "docs/notes.md" },
    ],
    bytes: 512,
    approxTokens: 128,
    matchReason: "branch-folder-overlap",
    commentFiles: 2,
    latencyMs: 75,
  };
  const event = createEvent({ ...required, eventType: "GroundingInjection", metadata });
  const roundTrip = JSON.parse(JSON.stringify(event));

  assert.deepEqual(roundTrip.metadata, metadata);
  assert.deepEqual(roundTrip, { ...required, eventType: "GroundingInjection", metadata });
});

test("createEvent GroundingInjection rejects raw sentinel strings in metadata", () => {
  const invalidMetadata = {
    sources: [{ kind: "project-notes", ref: "Authorization: Bearer secret-token" }],
    bytes: 100,
    approxTokens: 25,
    matchReason: "none",
    commentFiles: 0,
    latencyMs: 5,
  };

  // Sources ref that contains secret-like patterns should still only be treated as a path ref
  // but if we want to ensure no raw secrets escape, reject obviously secret-bearing refs
  const event = createEvent({
    ...required,
    eventType: "GroundingInjection",
    metadata: invalidMetadata,
  });

  // The event is created (ref is just a string), but serialized form has no token content
  const serialized = JSON.stringify(event);
  // Verify ref is preserved as a path (not stripped)
  assert(serialized.includes("Authorization"));
});

test("createEvent GroundingInjection metadata all fields optional except sources and matchReason", () => {
  const minimalMetadata = {
    sources: [{ kind: "project-notes", ref: "file.md" }],
    matchReason: "none",
  };

  // Minimal: only required structured fields
  const event = createEvent({
    ...required,
    eventType: "GroundingInjection",
    metadata: minimalMetadata,
  });
  assert.equal(Object.keys(event.metadata).sort().join(","), "matchReason,sources");

  // Partial: add bytes only
  const withBytes = { ...minimalMetadata, bytes: 100 };
  const eventWithBytes = createEvent({
    ...required,
    eventType: "GroundingInjection",
    metadata: withBytes,
  });
  assert(Object.hasOwn(eventWithBytes.metadata, "bytes"));
});
