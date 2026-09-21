import { utcMonth } from "../../src/grounding-event.mjs";
import { environmentValue } from "../../src/environment.mjs";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createEvent } from "../../src/protocol/event.mjs";

const DEFAULT_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_QUEUE_MAX = 256;
const MIN_QUEUE_MAX = 1;
const MAX_QUEUE_MAX = 256;
// Preserve legacy identity bytes so fallback aggregate IDs remain stable.
const DEFAULT_HMAC_KEY = Buffer.from("agent-harness-opencode-coalescer-v1");
// Cooperative labels that must always be preserved one-for-one regardless of
// configuration. These event types are intentionally absent from
// SESSION_EVENT_TYPES / GLOBAL_NOISE_EVENT_TYPES below, so they already fall
// through to emitEvent() without any label lookup.
const REQUIRED_PRESERVE_LABELS = Object.freeze(["lifecycle", "tool", "permission", "error"]);
const SESSION_EVENT_TYPES = new Set([
  "CommandExecute", "MessagePartDelta", "MessagePartUpdate", "MessageRemove", "MessageUpdate",
  "SessionDiff", "SessionStatus", "SessionUpdate", "TodoUpdate",
]);
const GLOBAL_NOISE_EVENT_TYPES = new Set([
  "FileEdit", "FileWatcher", "InstallationUpdate", "LspDiagnostics", "LspUpdate", "Pty", "ServerConnected",
  "TuiCommandExecute", "TuiPromptAppend", "TuiToastShow",
  "Vcs",
]);
// The closed set of HarnessMetrics summary counters (src/protocol/event.mjs
// enforces the same nine fields). Every event type that can be coalesced
// maps to one of these; anything without a dedicated field rolls into "noise".
const SUMMARY_COUNTER_FIELDS = Object.freeze([
  "coalesced", "messagePartDelta", "messagePartUpdate", "messageUpdate",
  "sessionStatus", "sessionDiff", "todoUpdate", "noise", "queueFull",
]);
const SUMMARY_FIELD_BY_EVENT_TYPE = new Map([
  ["MessagePartDelta", "messagePartDelta"],
  ["MessagePartUpdate", "messagePartUpdate"],
  ["MessageUpdate", "messageUpdate"],
  ["SessionStatus", "sessionStatus"],
  ["SessionDiff", "sessionDiff"],
  ["TodoUpdate", "todoUpdate"],
]);
const EVENT_FIELDS = [
  "schemaVersion", "eventID", "runID", "platform", "sessionHMAC", "eventType", "timestamp", "dedupeKey",
  "sequence", "adapterVersion", "previousEventHMAC", "parentSessionHMAC", "attemptID", "callID", "repoID",
  "worktreeID", "toolName", "subjectID", "decision", "summary",
];

function hmac(key, domain, value) {
  const mac = createHmac("sha256", key);
  for (const part of [domain, value]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    mac.update(length).update(bytes);
  }
  return mac.digest("hex");
}

function emptySummary() {
  return Object.fromEntries(SUMMARY_COUNTER_FIELDS.map((field) => [field, 0]));
}

// `generation` disambiguates two summaries that would otherwise collide: an
// evicted-and-recreated aggregate can accumulate the exact same scope,
// bucket, and counter values as an already-committed one within the same
// still-open window. `epoch` (e.g. an injected UTC-month retention epoch)
// time-partitions global metrics so an archived epoch's IDs are never reused
// once retention rolls over.
function summaryIdentity(scopeKey, bucket, summary, epoch, generation) {
  return `${scopeKey}\0${bucket}\0${epoch ?? ""}\0${generation}\0${SUMMARY_COUNTER_FIELDS.map((field) => `${field}:${summary[field]}`).join(",")}`;
}

function validConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(["schemaVersion", "enabled", "windowMs", "queueMax", "preserveLabels", "dlpOverride"]);
  if (Object.keys(value).some((field) => !allowed.has(field)) || value.schemaVersion !== 1 ||
      typeof value.enabled !== "boolean" || value.dlpOverride !== true ||
      !Array.isArray(value.preserveLabels) ||
      new Set(value.preserveLabels).size !== value.preserveLabels.length ||
      value.preserveLabels.some((label) => typeof label !== "string" || label.length === 0)) return false;
  if (value.windowMs !== undefined && (!Number.isInteger(value.windowMs) || value.windowMs < 1)) return false;
  if (value.preserveLabels.length !== REQUIRED_PRESERVE_LABELS.length ||
      !REQUIRED_PRESERVE_LABELS.every((label) => value.preserveLabels.includes(label))) return false;
  return value.queueMax === undefined ||
    (Number.isInteger(value.queueMax) && value.queueMax >= MIN_QUEUE_MAX && value.queueMax <= MAX_QUEUE_MAX);
}

export async function loadCoalescingConfig(path) {
  const disabled = {
    enabled: false,
    windowMs: DEFAULT_WINDOW_MS,
    queueMax: DEFAULT_QUEUE_MAX,
    preserveLabels: [...REQUIRED_PRESERVE_LABELS],
    dlpOverride: true,
  };
  // Precedence: explicit argument > Compass env (legacy alias if absent) >
  // <state dir>/coalescing.json, where the state dir uses the same alias rule or
  // the default ~/.local/state/compass. An explicit env override that is set
  // but missing/invalid fails closed (disabled) rather than falling back further.
  try {
    const stateDir = environmentValue("STATE_DIR") ?? join(homedir(), ".local/state/compass");
    const effectivePath = path ?? environmentValue("COALESCING_CONFIG") ?? join(stateDir, "coalescing.json");
    if (typeof effectivePath !== "string" || effectivePath.length === 0) return disabled;
    const config = JSON.parse(await readFile(effectivePath, "utf8"));
    if (!validConfig(config)) throw new TypeError("invalid coalescing config");
    return {
      enabled: config.enabled,
      windowMs: config.windowMs ?? DEFAULT_WINDOW_MS,
      queueMax: config.queueMax ?? DEFAULT_QUEUE_MAX,
      preserveLabels: [...REQUIRED_PRESERVE_LABELS],
      dlpOverride: config.dlpOverride,
    };
  } catch {
    return disabled;
  }
}

export function createEventCoalescer({
  enqueue,
  authKey,
  enabled = true,
  windowMs = DEFAULT_WINDOW_MS,
  queueMax = DEFAULT_QUEUE_MAX,
  preserveLabels = REQUIRED_PRESERVE_LABELS,
  dlpOverride = true,
  // Omitted: current UTC month. Empty string: legacy unscoped identity replay.
  retentionEpoch,
  now = () => new Date(),
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
} = {}) {
  if (typeof enqueue !== "function") throw new TypeError("enqueue must be a function");
  if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError("windowMs must be a positive integer");
  if (!Number.isInteger(queueMax) || queueMax < MIN_QUEUE_MAX || queueMax > MAX_QUEUE_MAX) {
    throw new TypeError("queueMax must be an integer between 1 and 256");
  }

  const key = Buffer.isBuffer(authKey) ? authKey : DEFAULT_HMAC_KEY;
  const dlpEnabled = dlpOverride !== false;
  const buckets = new Map();
  // Per-bucket-id monotonic counters backing the `generation` token in
  // summaryIdentity(). Retained only until that bucket id's window truly
  // expires (see flushCompleted()), so this stays bounded rather than
  // growing for the lifetime of the process.
  const generations = new Map();
  let timer;
  let disposed = false;

  function emitEvent(event) {
    const closed = Object.fromEntries(EVENT_FIELDS.filter((field) => Object.hasOwn(event, field)).map((field) => [field, event[field]]));
    enqueue(createEvent(closed));
  }

  function timestamp() {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(milliseconds)) throw new TypeError("now must return a valid date");
    return milliseconds;
  }

  function scheduleFlush() {
    if (timer || buckets.size === 0 || disposed) return;
    timer = schedule(() => {
      timer = undefined;
      flushCompleted(timestamp());
      scheduleFlush();
    }, windowMs);
    timer?.unref?.();
  }

  function createBucket(scope, runID, sessionHMAC, bucket, epoch) {
    const globalEpoch = epoch ? `global:${epoch}` : "global";
    return {
      scope,
      epoch,
      bucket,
      runID: scope === "global" ? hmac(key, "opencode.metrics.run", globalEpoch) : runID,
      sessionHMAC: scope === "global" ? hmac(key, "opencode.metrics.subject", globalEpoch) : sessionHMAC,
      summary: emptySummary(),
    };
  }

  function addSummary(target, source) {
    for (const field of SUMMARY_COUNTER_FIELDS) target[field] += source[field];
  }

  function nextGeneration(id) {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    return generation;
  }

  function removeAggregate(aggregate) {
    for (const [id, value] of buckets) {
      if (value === aggregate) {
        buckets.delete(id);
        generations.delete(id);
        return;
      }
    }
  }

  function getGlobalBucket(milliseconds) {
    const bucket = Math.floor(milliseconds / windowMs) * windowMs;
    const epoch = retentionEpoch ?? utcMonth(new Date(milliseconds));
    const id = `global\0${epoch}\0${bucket}`;
    let aggregate = buckets.get(id);
    if (!aggregate) {
      // Overflow accounting takes precedence over a retained session bucket.
      // This keeps cardinality bounded while ensuring subsequent drops have a
      // single global counter rather than creating unbounded per-run buckets.
      if (buckets.size >= queueMax) {
        const existing = [...buckets.entries()].find(([, value]) => value.scope === "global");
        if (existing) {
          const [oldID, retained] = existing;
          if (retained.epoch !== epoch) {
            // Freeze old-month counts before reusing bounded storage. A pending
            // event keeps its identity on retry; never fold new counts into it.
            tryEmit(oldID, retained);
            // With both an immutable retry and unacknowledged mutable counts,
            // there is no free bounded slot. Drop new telemetry rather than
            // attributing it to a previous month.
            if (hasCounts(retained.summary)) return undefined;
            buckets.delete(oldID);
            generations.delete(oldID);
            Object.assign(retained, createBucket("global", "", "", bucket, epoch));
            buckets.set(id, retained);
            return { id, aggregate: retained };
          }
          return { id: oldID, aggregate: retained };
        }
        const session = [...buckets.entries()].find(([, value]) => value.scope === "session");
        if (!session) return undefined;
        buckets.delete(session[0]);
        generations.delete(session[0]);
        if (session[1].pending) {
          // Keep a committed-but-unacknowledged event retryable with its
          // original identity while reusing this bounded bucket for overflow.
          session[1].scope = "global";
          session[1].bucket = bucket;
          session[1].epoch = epoch;
          session[1].runID = hmac(key, "opencode.metrics.run", epoch ? `global:${epoch}` : "global");
          session[1].sessionHMAC = hmac(key, "opencode.metrics.subject", epoch ? `global:${epoch}` : "global");
          buckets.set(id, session[1]);
          return { id, aggregate: session[1] };
        }
        aggregate = createBucket("global", "", "", bucket, epoch);
        addSummary(aggregate.summary, session[1].summary);
        buckets.set(id, aggregate);
        return { id, aggregate };
      }
      aggregate = createBucket("global", "", "", bucket, epoch);
      buckets.set(id, aggregate);
    }
    return { id, aggregate };
  }

  function getBucket(scope, runID, sessionHMAC, milliseconds) {
    if (scope === "global") return getGlobalBucket(milliseconds);
    const bucket = Math.floor(milliseconds / windowMs) * windowMs;
    const id = `${scope}\0${runID}\0${bucket}`;
    const aggregate = buckets.get(id);
    if (aggregate) return { id, aggregate };

    if (buckets.size >= queueMax) {
      const global = getGlobalBucket(milliseconds);
      return { ...global, overflow: true };
    }
    const session = createBucket(scope, runID, sessionHMAC, bucket);
    buckets.set(id, session);
    return { id, aggregate: session };
  }

  function record(scope, event, eventType, milliseconds = timestamp()) {
    const bucket = getBucket(scope, event.runID, event.sessionHMAC, milliseconds);
    if (!bucket?.aggregate) return;
    const { aggregate } = bucket;
    if (bucket.overflow) {
      aggregate.summary.queueFull += 1;
      scheduleFlush();
      return;
    }
    const field = SUMMARY_FIELD_BY_EVENT_TYPE.get(eventType) ?? "noise";
    aggregate.summary[field] += 1;
    aggregate.summary.coalesced += 1;
    scheduleFlush();
  }

  function hasCounts(summary) {
    return SUMMARY_COUNTER_FIELDS.some((field) => summary[field] !== 0);
  }

  function acknowledge(aggregate, pending, admitted) {
    aggregate.inFlight = false;
    if (admitted === false || aggregate.pending !== pending) return false;
    aggregate.pending = undefined;
    return hasCounts(aggregate.summary);
  }

  // Attempts to emit one aggregate's HarnessMetrics summary. A synchronous
  // false is an admission NACK; an asynchronous result is the append ACK/NACK
  // supplied by the server queue. Buckets are deleted only after an ACK.
  function tryEmit(id, aggregate) {
    if (!aggregate.pending && !hasCounts(aggregate.summary)) {
      return true;
    }
    if (aggregate.inFlight) return true;
    const pending = aggregate.pending ?? (() => {
      const snapshot = Object.freeze({ ...aggregate.summary });
      const generation = nextGeneration(id);
      const identity = summaryIdentity(
        aggregate.scope === "global" ? "global" : aggregate.runID,
        aggregate.bucket,
        snapshot,
        aggregate.scope === "global" ? aggregate.epoch : retentionEpoch,
        generation,
      );
      const entry = Object.freeze({
        snapshot,
        event: createEvent({
          schemaVersion: 1,
          eventID: hmac(key, "opencode.metrics.event", identity),
          runID: aggregate.runID,
          platform: "opencode",
          sessionHMAC: aggregate.sessionHMAC,
          eventType: "HarnessMetrics",
          timestamp: new Date(aggregate.bucket).toISOString(),
          dedupeKey: hmac(key, "opencode.metrics.dedupe", identity),
          adapterVersion: "1",
          summary: snapshot,
        }),
      });
      aggregate.summary = emptySummary();
      aggregate.pending = entry;
      return entry;
    })();
    const admitted = enqueue(pending.event);
    if (admitted === false) return false;
    if (typeof admitted?.then === "function") {
      aggregate.inFlight = true;
      Promise.resolve(admitted).then(
        (ack) => {
          if (acknowledge(aggregate, pending, ack)) tryEmit(id, aggregate);
        },
        () => acknowledge(aggregate, pending, false),
      );
      return true;
    }
    return acknowledge(aggregate, pending, admitted) ? tryEmit(id, aggregate) : true;
  }

  function flushCompleted(milliseconds) {
    for (const [id, aggregate] of buckets) {
      if (aggregate.bucket + windowMs <= milliseconds) {
        tryEmit(id, aggregate);
        // This bucket id's window has truly elapsed: bucket ids are derived
        // from an ever-increasing clock, so no future record() call can ever
        // target this exact id again. Remove it only after its summary is ACKed.
        if (!aggregate.inFlight && !aggregate.pending && !hasCounts(aggregate.summary)) removeAggregate(aggregate);
      }
    }
  }

  return {
    push(event) {
      if (disposed) return;
      const milliseconds = timestamp();
      flushCompleted(milliseconds);
      if (!enabled) {
        if (GLOBAL_NOISE_EVENT_TYPES.has(event.eventType) && !(dlpEnabled && event.decision)) return;
        emitEvent(event);
      } else if (SESSION_EVENT_TYPES.has(event.eventType)) {
        if (dlpEnabled && event.decision) {
          emitEvent(event);
          return;
        }
        record("session", event, event.eventType, milliseconds);
      } else if (GLOBAL_NOISE_EVENT_TYPES.has(event.eventType)) {
        if (dlpEnabled && event.decision) {
          emitEvent(event);
          return;
        }
        record("global", event, event.eventType, milliseconds);
      } else {
        emitEvent(event);
      }
      scheduleFlush();
    },
    recordQueueFull({ replacePending = false } = {}) {
      // Unlike push(), this is not gated on disposed: dispose()'s bounded
      // drain may still need to record a drop (e.g. a worker-timeout queue
      // truncation) after the coalescer has already been marked disposed,
      // and the count must survive the retryable flush() that follows.
      const milliseconds = timestamp();
      flushCompleted(milliseconds);
      const global = getBucket("global", "", "", milliseconds);
      if (global?.aggregate) {
        // A HarnessMetrics admission can evict a raw event while tryEmit() is
        // still on the stack. Its deferred queueFull accounting can replace a
        // synchronously rejected, not-in-flight snapshot before retrying, so
        // both counts are emitted once without reentering tryEmit().
        if (replacePending && global.aggregate.pending && !global.aggregate.inFlight &&
            global.aggregate.pending.event.runID === global.aggregate.runID) {
          addSummary(global.aggregate.summary, global.aggregate.pending.snapshot);
          global.aggregate.pending = undefined;
        }
        global.aggregate.summary.queueFull += 1;
      }
      scheduleFlush();
    },
    // Flushes every open bucket regardless of window rollover. Returns the
    // aggregates that a bounded admission callback declined to admit, so
    // callers (including dispose()) can observe summaries that were rejected
    // or are still awaiting an append ACK, instead of silently losing counts.
    async flush() {
      if (timer) {
        cancel(timer);
        timer = undefined;
      }
      const unsent = [];
      for (const [id, aggregate] of buckets) {
        if (!tryEmit(id, aggregate) || aggregate.inFlight || aggregate.pending) unsent.push(aggregate);
      }
      return unsent;
    },
    async dispose() {
      if (disposed) return [];
      disposed = true;
      return this.flush();
    },
  };
}
