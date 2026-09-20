import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEventCoalescer, loadCoalescingConfig } from "../../../adapters/opencode/coalescer.mjs";

const TEN_MINUTES = 10 * 60 * 1_000;
const start = Date.parse("2026-08-24T12:00:00.000Z");
const sentinel = "RAW-SENTINEL-must-never-reach-the-summary";
const originalStateDir = process.env.AGENT_HARNESS_STATE_DIR;
const originalCoalescingConfig = process.env.AGENT_HARNESS_COALESCING_CONFIG;
const hermeticStateDir = mkdtempSync(join(tmpdir(), "ah-opencode-state-"));
process.env.AGENT_HARNESS_STATE_DIR = hermeticStateDir;
delete process.env.AGENT_HARNESS_COALESCING_CONFIG;
let environmentRestored = false;
function restoreEnvironment() {
  if (environmentRestored) return;
  environmentRestored = true;
  if (originalStateDir === undefined) delete process.env.AGENT_HARNESS_STATE_DIR;
  else process.env.AGENT_HARNESS_STATE_DIR = originalStateDir;
  if (originalCoalescingConfig === undefined) delete process.env.AGENT_HARNESS_COALESCING_CONFIG;
  else process.env.AGENT_HARNESS_COALESCING_CONFIG = originalCoalescingConfig;
  rmSync(hermeticStateDir, { recursive: true, force: true });
}
process.once("exit", restoreEnvironment);
test.after(restoreEnvironment);

function digest(byte) {
  return byte.toString(16).padStart(2, "0").repeat(32);
}

function uniqueDigest(index, suffix) {
  return `${index.toString(16).padStart(62, "0")}${suffix}`;
}

function event(eventType, {
  runID = digest(0x11),
  sessionHMAC = digest(0x22),
  timestamp = new Date(start).toISOString(),
  eventID = `${eventType}-${runID}`,
  decision,
  raw,
} = {}) {
  return {
    schemaVersion: 1,
    eventID: digest(eventID.length & 0xff),
    runID,
    platform: "opencode",
    sessionHMAC,
    eventType,
    timestamp,
    dedupeKey: digest((eventID.length + 1) & 0xff),
    ...(decision ? { decision } : {}),
    ...(raw === undefined ? {} : { raw }),
  };
}

function fakeHarness({ enabled = true, windowMs = TEN_MINUTES, queueMax, preserveLabels, dlpOverride, admit } = {}) {
  let current = start;
  let nextTimer = 0;
  const timers = new Map();
  const enqueued = [];
  const scheduled = [];
  const cleared = [];

  function setTimeoutFake(callback, delay) {
    const handle = { id: ++nextTimer, unref() {} };
    timers.set(handle, { callback, due: current + delay });
    scheduled.push(handle);
    return handle;
  }

  function clearTimeoutFake(handle) {
    cleared.push(handle);
    timers.delete(handle);
  }

  function advance(milliseconds) {
    current += milliseconds;
    let ran;
    do {
      ran = false;
      for (const [handle, timer] of [...timers]) {
        if (timer.due <= current) {
          timers.delete(handle);
          timer.callback();
          ran = true;
        }
      }
    } while (ran);
  }

  const admitEvent = admit ?? (() => true);
  const coalescer = createEventCoalescer({
    enqueue: (value) => {
      const admitted = admitEvent(value);
      if (admitted === false) return false;
      enqueued.push(value);
      return admitted;
    },
    now: () => new Date(current),
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    enabled,
    windowMs,
    queueMax,
    preserveLabels,
    dlpOverride,
  });

  return {
    coalescer,
    enqueued,
    scheduled,
    cleared,
    advance,
    get current() { return current; },
  };
}

function summaries(enqueued) {
  return enqueued.filter(({ eventType }) => eventType === "HarnessMetrics");
}

function summary(metrics) {
  assert.ok(metrics.summary, "HarnessMetrics must contain summary");
  return metrics.summary;
}

test("preserves lifecycle, permission, tool, and every DLP-decision event one-for-one", async () => {
  const harness = fakeHarness();
  const preserved = [
    "SessionStart", "SessionEnd", "Stop", "StopFailure", "PostCompact",
    "PermissionRequest", "PermissionResponse", "QuestionRequest", "QuestionResponse",
    "PreToolUse", "PostToolUse",
  ].map((eventType, index) => event(eventType, { eventID: `${eventType}-${index}` }));
  const decisions = ["MessagePartUpdate", "MessageUpdate", "SessionStatus", "TodoUpdate"].map((eventType, index) => event(eventType, {
    eventID: `decision-${index}`,
    decision: {
      schemaVersion: 1,
      action: "observe",
      ruleIDs: ["dlp.synthetic"],
      reason: "Credential-shaped content was observed",
    },
  }));

  for (const input of [...preserved, ...decisions]) harness.coalescer.push(input);
  await harness.coalescer.dispose();

  assert.equal(summaries(harness.enqueued).length, 0);
  assert.deepEqual(harness.enqueued, [...preserved, ...decisions]);
});

test("coalesces noisy session events into one per-run summary and non-session noise into one global summary", async () => {
  const harness = fakeHarness();
  const runID = digest(0x31);
  const sessionHMAC = digest(0x32);
  const aggregateTypes = [
    "MessagePartUpdate", "MessagePartUpdate", "MessageUpdate", "SessionStatus",
    "SessionDiff", "TodoUpdate", "SessionUpdate", "MessageRemove", "CommandExecute",
  ];
  for (const [index, eventType] of aggregateTypes.entries()) {
    harness.coalescer.push(event(eventType, {
      runID,
      sessionHMAC,
      eventID: `aggregate-${index}`,
    }));
  }

  for (const [index, eventType] of [
    "FileEdit", "InstallationUpdate", "LspDiagnostics", "LspUpdate",
    "ServerConnected", "TuiPromptAppend", "TuiCommandExecute", "TuiToastShow",
  ].entries()) {
    harness.coalescer.push(event(eventType, {
      runID: digest(0x40 + index),
      sessionHMAC: digest(0x50 + index),
      eventID: `noise-${index}`,
    }));
  }
  await harness.coalescer.dispose();

  const metrics = summaries(harness.enqueued);
  assert.equal(metrics.length, 2);
  const sessionSummary = metrics.find((summary) => summary.runID === runID);
  const globalSummary = metrics.find((summary) => summary.runID !== runID);
  assert.ok(sessionSummary);
  assert.ok(globalSummary);
  assert.deepEqual(summary(sessionSummary), {
    coalesced: 9,
    messagePartDelta: 0,
    messagePartUpdate: 2,
    messageUpdate: 1,
    sessionStatus: 1,
    sessionDiff: 1,
    todoUpdate: 1,
    noise: 3,
    queueFull: 0,
  });
  assert.deepEqual(summary(globalSummary), {
    coalesced: 8,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 8,
    queueFull: 0,
  });
  for (const summary of metrics) {
    assert.equal(summary.eventType, "HarnessMetrics");
    assert.equal(JSON.stringify(summary).includes(sentinel), false);
    assert.deepEqual(Object.keys(summary).sort(), [
       "adapterVersion", "dedupeKey", "eventID", "eventType", "platform",
       "runID", "schemaVersion", "sessionHMAC", "summary", "timestamp",
    ]);
  }
});

test("flushes the completed bucket on rollover and the open bucket on dispose", async () => {
  const harness = fakeHarness();
  const runID = digest(0x61);
  harness.coalescer.push(event("MessageUpdate", { runID, sessionHMAC: digest(0x62) }));
  harness.advance(TEN_MINUTES);
  assert.equal(summaries(harness.enqueued).length, 1);
  assert.deepEqual(summary(summaries(harness.enqueued)[0]), {
    coalesced: 1,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 1,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });

  harness.advance(1);
  harness.coalescer.push(event("SessionStatus", { runID, sessionHMAC: digest(0x62) }));
  assert.equal(summaries(harness.enqueued).length, 1);
  await harness.coalescer.dispose();
  assert.equal(summaries(harness.enqueued).length, 2);
  assert.deepEqual(summary(summaries(harness.enqueued)[1]), {
    coalesced: 1,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 1,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
});

test("summary identities are deterministic and a repeated flush is dedupeable", async () => {
  const first = fakeHarness();
  const second = fakeHarness();
  const input = event("MessageUpdate", { runID: digest(0x71), sessionHMAC: digest(0x72) });
  first.coalescer.push(input);
  second.coalescer.push({ ...input });
  await first.coalescer.dispose();
  await second.coalescer.dispose();

  const [one] = summaries(first.enqueued);
  const [two] = summaries(second.enqueued);
  assert.equal(one.eventID, two.eventID);
  assert.equal(one.dedupeKey, two.dedupeKey);
  assert.deepEqual(one, two);
  await first.coalescer.flush();
  assert.equal(summaries(first.enqueued).length, 1);
});

test("retains no more than five percent of a synthetic 471k event mix", async () => {
  const harness = fakeHarness();
  const runID = digest(0x81);
  const sessionHMAC = digest(0x82);
  const inputCount = 471_000;
  const preservedCount = 20_000;
  for (let index = 0; index < inputCount; index += 1) {
    harness.coalescer.push(event(index < preservedCount ? "PostToolUse" : "MessageUpdate", {
      runID,
      sessionHMAC,
      eventID: `volume-${index}`,
      raw: `${sentinel}-${index}`,
    }));
  }
  await harness.coalescer.dispose();

  assert.ok(harness.enqueued.length <= inputCount * 0.05, `retained ${harness.enqueued.length} of ${inputCount}`);
  assert.equal(JSON.stringify(harness.enqueued).includes(sentinel), false);
});

test("preserves every mandatory and DLP event in a sanitized 480-run multi-window histogram", async () => {
  const runs = 480;
  const windows = 3;
  const noisyEventsPerRunPerWindow = 100;
  const windowMs = 1_000;
  const harness = fakeHarness({ windowMs });
  const mandatoryTypes = ["SessionStart", "PreToolUse", "PermissionRequest", "StopFailure"];
  const decision = {
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  };
  let inputCount = 0;

  for (let window = 0; window < windows; window += 1) {
    for (let run = 0; run < runs; run += 1) {
      const runID = uniqueDigest(run, "11");
      const sessionHMAC = uniqueDigest(run, "22");
      if (window === 0) {
        for (const eventType of mandatoryTypes) {
          harness.coalescer.push(event(eventType, { runID, sessionHMAC, eventID: `${eventType}-${run}` }));
          inputCount += 1;
        }
        harness.coalescer.push(event("MessagePartDelta", {
          runID,
          sessionHMAC,
          eventID: `dlp-${run}`,
          decision,
          raw: "live-secret-must-not-be-retained",
        }));
        inputCount += 1;
      }
      for (let noise = 0; noise < noisyEventsPerRunPerWindow; noise += 1) {
        harness.coalescer.push(event("MessagePartDelta", {
          runID,
          sessionHMAC,
          eventID: `noise-${window}-${run}-${noise}`,
          raw: "live-secret-must-not-be-retained",
        }));
        inputCount += 1;
      }
    }
    harness.advance(windowMs);
  }
  await harness.coalescer.dispose();

  const histogram = new Map();
  for (const value of harness.enqueued) histogram.set(value.eventType, (histogram.get(value.eventType) ?? 0) + 1);
  assert.equal(histogram.get("SessionStart"), runs);
  assert.equal(histogram.get("PreToolUse"), runs);
  assert.equal(histogram.get("PermissionRequest"), runs);
  assert.equal(histogram.get("StopFailure"), runs);
  assert.equal(harness.enqueued.filter(({ eventType, decision: value }) => eventType === "MessagePartDelta" && value).length, runs);
  assert.ok(harness.enqueued.length <= inputCount * 0.05, `retained ${harness.enqueued.length} of ${inputCount}`);
  assert.equal(JSON.stringify(harness.enqueued).includes("live-secret"), false);
});

test("dispose flushes queue-full metrics and cancels the timer exactly once", async () => {
  const harness = fakeHarness();
  const runID = digest(0x91);
  harness.coalescer.push(event("MessageUpdate", { runID, sessionHMAC: digest(0x92) }));
  harness.coalescer.recordQueueFull();

  assert.equal(harness.scheduled.length, 1);
  await harness.coalescer.dispose();

  const metrics = summaries(harness.enqueued);
  assert.equal(metrics.length, 2);
  const sessionSummary = metrics.find((value) => value.runID === runID);
  const globalSummary = metrics.find((value) => value.runID !== runID);
  assert.ok(sessionSummary);
  assert.ok(globalSummary);
  assert.deepEqual(summary(sessionSummary), {
    coalesced: 1,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 1,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
  assert.deepEqual(summary(globalSummary), {
    coalesced: 0,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 1,
  });
  assert.deepEqual({
    coalesced: summary(sessionSummary).coalesced + summary(globalSummary).coalesced,
    messagePartDelta: summary(sessionSummary).messagePartDelta + summary(globalSummary).messagePartDelta,
    messagePartUpdate: summary(sessionSummary).messagePartUpdate + summary(globalSummary).messagePartUpdate,
    messageUpdate: summary(sessionSummary).messageUpdate + summary(globalSummary).messageUpdate,
    sessionStatus: summary(sessionSummary).sessionStatus + summary(globalSummary).sessionStatus,
    sessionDiff: summary(sessionSummary).sessionDiff + summary(globalSummary).sessionDiff,
    todoUpdate: summary(sessionSummary).todoUpdate + summary(globalSummary).todoUpdate,
    noise: summary(sessionSummary).noise + summary(globalSummary).noise,
    queueFull: summary(sessionSummary).queueFull + summary(globalSummary).queueFull,
  }, {
    coalesced: 1,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 1,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 1,
  });
  assert.equal(harness.cleared.length, 1);

  harness.advance(TEN_MINUTES * 2);
  assert.equal(summaries(harness.enqueued).length, 2);
});

test("bounds a summary burst to one pending summary and retries an unadmitted summary", async () => {
  let blocked = true;
  let attempts = 0;
  const harness = fakeHarness({
    admit(value) {
      if (value.eventType !== "HarnessMetrics") return true;
      attempts += 1;
      return !blocked;
    },
  });

  for (let index = 0; index < 10_000; index += 1) {
    harness.coalescer.push(event("MessageUpdate", {
      runID: digest(0xa1),
      sessionHMAC: digest(0xa2),
      eventID: `burst-${index}`,
    }));
  }
  await harness.coalescer.flush();

  assert.equal(attempts, 1, "a burst in one bucket must not create an unbounded summary queue");
  assert.equal(summaries(harness.enqueued).length, 0);

  blocked = false;
  await harness.coalescer.flush();
  assert.equal(summaries(harness.enqueued).length, 1);
  assert.deepEqual(summary(summaries(harness.enqueued)[0]), {
    coalesced: 10_000,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 10_000,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
});

test("bounds bucket cardinality by queueMax and reports overflow in the global bucket", async () => {
  const queueMax = 2;
  const harness = fakeHarness({ queueMax });
  for (let index = 0; index < 5; index += 1) {
    harness.coalescer.push(event("MessageUpdate", {
      runID: digest(0xc1 + index),
      sessionHMAC: digest(0xd1 + index),
      eventID: `bucket-overflow-${index}`,
    }));
  }
  await harness.coalescer.dispose();

  const metrics = summaries(harness.enqueued);
  assert.ok(metrics.length <= queueMax, `retained ${metrics.length} buckets with queueMax=${queueMax}`);
  const global = metrics.find(({ summary: value }) => value.queueFull > 0);
  assert.ok(global, "bucket overflow must be represented in the global summary");
  assert.equal(summary(global).queueFull, 3);
});

test("RED: bucket pressure folds an evicted session aggregate into global overflow and counts pressure", async () => {
  const harness = fakeHarness({ queueMax: 2 });
  const evictedRun = digest(0xe1);
  const retainedRun = digest(0xe2);

  for (let index = 0; index < 2; index += 1) {
    harness.coalescer.push(event("MessageUpdate", {
      runID: evictedRun,
      sessionHMAC: digest(0xf1),
      eventID: `evicted-${index}`,
    }));
  }
  for (let index = 0; index < 3; index += 1) {
    harness.coalescer.push(event("MessagePartUpdate", {
      runID: retainedRun,
      sessionHMAC: digest(0xf2),
      eventID: `retained-${index}`,
    }));
  }
  harness.coalescer.push(event("SessionStatus", {
    runID: digest(0xe3),
    sessionHMAC: digest(0xf3),
    eventID: "overflow-1",
  }));
  harness.coalescer.push(event("SessionStatus", {
    runID: digest(0xe4),
    sessionHMAC: digest(0xf4),
    eventID: "overflow-2",
  }));
  await harness.coalescer.dispose();

  const metrics = summaries(harness.enqueued);
  const global = metrics.find(({ summary: value }) => value.queueFull > 0);
  const retained = metrics.find(({ runID }) => runID === retainedRun);
  assert.ok(global, "overflow must have a global summary");
  assert.ok(retained, "the non-evicted session must remain represented");
  assert.deepEqual(summary(global), {
    coalesced: 2,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 2,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 2,
  });
  assert.deepEqual(summary(retained), {
    coalesced: 3,
    messagePartDelta: 0,
    messagePartUpdate: 3,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
});

test("runtime rejects labels outside the required set while messages remain coalesced", async () => {
  const root = await mkdtemp(join(tmpdir(), "ah-coalescing-config-"));
  const path = join(root, "coalescing.json");
  const requiredLabels = ["lifecycle", "tool", "permission", "error"];
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    preserveLabels: requiredLabels,
    dlpOverride: true,
  }));

  const config = await loadCoalescingConfig(path);
  assert.equal(config.enabled, true);
  assert.equal(config.dlpOverride, true);
  assert.deepEqual(config.preserveLabels, requiredLabels);

  for (const label of ["message", "unknown"]) {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      preserveLabels: [...requiredLabels, label],
      dlpOverride: true,
    }));
    const invalid = await loadCoalescingConfig(path);
    assert.equal(invalid.enabled, false, `category ${label} must be rejected`);
    assert.deepEqual(invalid.preserveLabels, requiredLabels);
  }

  const harness = fakeHarness({ enabled: config.enabled, preserveLabels: config.preserveLabels, dlpOverride: config.dlpOverride });
  harness.coalescer.push(event("SessionStart", { eventID: "required-lifecycle" }));
  harness.coalescer.push(event("MessageUpdate", { eventID: "configured-message-1" }));
  harness.coalescer.push(event("MessageUpdate", { eventID: "configured-message-2" }));
  await harness.coalescer.dispose();

  assert.deepEqual(harness.enqueued.map(({ eventType }) => eventType), ["SessionStart", "HarnessMetrics"]);
  assert.deepEqual(summary(summaries(harness.enqueued)[0]), {
    coalesced: 2,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 2,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
});

test("DLP override preserves a decision even when no optional label is configured", async () => {
  const harness = fakeHarness({ enabled: true, preserveLabels: [], dlpOverride: true });
  const decision = {
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.synthetic"],
    reason: "Credential-shaped content was observed",
  };
  harness.coalescer.push(event("MessageUpdate", { eventID: "safe-coalesced" }));
  harness.coalescer.push(event("MessageUpdate", {
    eventID: "dlp-preserved",
    decision,
  }));
  await harness.coalescer.dispose();

  assert.equal(summaries(harness.enqueued).length, 1);
  assert.deepEqual(summary(summaries(harness.enqueued)[0]), {
    coalesced: 1,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 1,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
  assert.deepEqual(harness.enqueued.find(({ decision: value }) => value)?.decision, decision);
});

test("enabled PTY and every known global-noise label share one global aggregate", async () => {
  const harness = fakeHarness({ enabled: true });
  for (const [index, eventType] of [
    "Pty", "FileWatcher", "Vcs", "FileEdit", "InstallationUpdate", "LspDiagnostics", "LspUpdate",
    "ServerConnected", "TuiPromptAppend", "TuiCommandExecute", "TuiToastShow",
  ].entries()) {
    harness.coalescer.push(event(eventType, {
      runID: digest(0xb0 + index),
      sessionHMAC: digest(0xc0 + index),
      eventID: `global-${index}`,
    }));
  }
  await harness.coalescer.dispose();

  const metrics = summaries(harness.enqueued);
  assert.equal(metrics.length, 1);
  assert.deepEqual(summary(metrics[0]), {
    coalesced: 11,
    messagePartDelta: 0,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 11,
    queueFull: 0,
  });
});

test("MessagePartDelta envelopes coalesce, while a DLP decision remains one-for-one", async () => {
  const harness = fakeHarness({ enabled: true, dlpOverride: true });
  harness.coalescer.push(event("MessagePartDelta", { eventID: "delta-1" }));
  harness.coalescer.push(event("MessagePartDelta", { eventID: "delta-2" }));
  harness.coalescer.push(event("MessagePartDelta", {
    eventID: "delta-secret",
    decision: {
      schemaVersion: 1,
      action: "observe",
      ruleIDs: ["dlp.bearer-token"],
      reason: "Credential-shaped content was observed",
    },
  }));
  await harness.coalescer.dispose();

  assert.equal(harness.enqueued.filter(({ eventType }) => eventType === "MessagePartDelta").length, 1);
  assert.deepEqual(summary(summaries(harness.enqueued)[0]), {
    coalesced: 2,
    messagePartDelta: 2,
    messagePartUpdate: 0,
    messageUpdate: 0,
    sessionStatus: 0,
    sessionDiff: 0,
    todoUpdate: 0,
    noise: 0,
    queueFull: 0,
  });
  assert.deepEqual(harness.enqueued.find(({ decision }) => decision)?.decision, {
    schemaVersion: 1,
    action: "observe",
    ruleIDs: ["dlp.bearer-token"],
    reason: "Credential-shaped content was observed",
  });
});

test("RED: lost ACK retries the committed summary immutably before emitting only the new delta", async () => {
  let rejectLostAck;
  const lostAck = new Promise((resolve, reject) => { rejectLostAck = reject; });
  const attempts = [];
  const harness = fakeHarness({
    admit(value) {
      if (value.eventType !== "HarnessMetrics") return true;
      attempts.push(value);
      return attempts.length === 1 ? lostAck : true;
    },
  });
  const runID = digest(0xa5);
  const sessionHMAC = digest(0xa6);

  harness.coalescer.push(event("MessageUpdate", { runID, sessionHMAC, eventID: "committed-1" }));
  harness.coalescer.push(event("MessageUpdate", { runID, sessionHMAC, eventID: "committed-2" }));
  await harness.coalescer.flush();
  assert.equal(attempts.length, 1);
  const original = attempts[0];

  harness.coalescer.push(event("MessageUpdate", { runID, sessionHMAC, eventID: "new-delta" }));
  rejectLostAck(new Error("append ACK was lost after commit"));
  await new Promise((resolve) => setImmediate(resolve));
  await harness.coalescer.flush();

  assert.deepEqual(attempts.map(({ summary: value }) => value.messageUpdate), [2, 2, 1]);
  assert.equal(attempts[1].eventID, original.eventID, "retry must keep the committed summary identity");
  assert.equal(attempts[1].dedupeKey, original.dedupeKey, "retry must keep the committed dedupe identity");
  assert.notEqual(attempts[2].eventID, original.eventID, "new input must be emitted as a new summary");
  assert.equal(attempts[2].summary.messageUpdate, 1);

  const uniqueSummaries = new Map(attempts.map((value) => [value.dedupeKey, value]));
  assert.equal([...uniqueSummaries.values()].reduce((total, value) => total + value.summary.messageUpdate, 0), 3);
});

test("RED: equal-sized summaries in one bucket get distinct IDs while a retry keeps its ID", async () => {
  let blocked = true;
  const attempts = [];
  const harness = fakeHarness({
    admit(value) {
      if (value.eventType !== "HarnessMetrics") return true;
      attempts.push(value);
      return !blocked;
    },
  });

  harness.coalescer.push(event("FileEdit", { eventID: "global-one" }));
  await harness.coalescer.flush();
  assert.equal(attempts.length, 1);

  blocked = false;
  await harness.coalescer.flush();
  harness.coalescer.push(event("FileEdit", { eventID: "global-two" }));
  await harness.coalescer.flush();

  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].eventID, attempts[1].eventID, "retry must preserve the rejected summary ID");
  assert.equal(attempts[0].dedupeKey, attempts[1].dedupeKey, "retry must preserve the rejected dedupe ID");
  assert.notEqual(attempts[1].eventID, attempts[2].eventID, "distinct summaries must not collide");
  assert.notEqual(attempts[1].dedupeKey, attempts[2].dedupeKey, "distinct summaries must not share a dedupe ID");
});
