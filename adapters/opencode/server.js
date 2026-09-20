import { utcMonth } from "../../src/grounding-event.mjs";
import { randomUUID } from "node:crypto";

import { readAuthKeyFile } from "../../src/paths.mjs";
import { redactText } from "../../src/dlp/redact.mjs";
import { request } from "../../src/supervisor/client.mjs";
import { createEventCoalescer, loadCoalescingConfig } from "./coalescer.mjs";
import { createGroundingCache, loadGroundingConfig } from "./grounding.mjs";
import { buildGroundingEvent, translateOpenCodeEvent } from "./translate.mjs";

const REQUEST_TIMEOUT = 1_000;
const DISPOSE_TIMEOUT = 100;
const MAX_QUEUE_SIZE = 256;
// How often drained grounding metadata is flushed into HarnessLedger-bound
// GroundingInjection events. This runs on its own unref'd timer so it never
// keeps the process alive and never runs from the system.transform hot path.
const GROUNDING_DRAIN_INTERVAL_MS = 30_000;
const GLOBAL_NOISE_TYPES = new Set([
  "file.edited", "installation.updated", "lsp.client.diagnostics", "lsp.updated", "server.connected",
  "tui.command.execute", "tui.prompt.append", "tui.toast.show",
]);
const PRIORITY_EVENT_TYPES = new Set([
  "SessionStart", "SessionEnd", "Stop", "StopFailure", "PostCompact",
  "PermissionRequest", "PermissionResponse", "QuestionRequest", "QuestionResponse",
  "PreToolUse", "PostToolUse", "HarnessMetrics",
]);

function ownString(value, field) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return typeof descriptor?.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isGlobalNoise(type) {
  return type?.startsWith("pty.") || type?.startsWith("file.watcher.") || type?.startsWith("vcs.") || GLOBAL_NOISE_TYPES.has(type);
}

function isPriorityEvent(event, preserveLabels) {
  if (event.decision || PRIORITY_EVENT_TYPES.has(event.eventType)) return true;
  return [...(preserveLabels ?? [])].includes("error") && event.eventType === "StopFailure";
}

export default async function OpenCodeShadow({
  directory, worktree, retentionEpoch, _createGroundingCache, _groundingCache,
} = {}) {
  const queue = [];
  const activeRequests = new Set();
  const coalescing = await loadCoalescingConfig();
  // Grounding cache construction and start() must stay synchronous and I/O-free:
  // the real cache defers its config load and vault/git warm to its own
  // background timer, so no `await` belongs here.
  const groundingCache = _groundingCache ?? (_createGroundingCache ?? createGroundingCache)({
    directory, worktree, loadConfig: loadGroundingConfig, redact: redactText,
  });
  groundingCache.start?.();
  let groundingTimer;
  const maxQueueSize = Math.max(1, Math.min(MAX_QUEUE_SIZE, coalescing.queueMax));
  let worker;
  let disposed = false;
  let stopping = false;
  let authKey;
  try {
    authKey = await readAuthKeyFile(process.env.AGENT_HARNESS_KEY_FILE);
  } catch {
    // Hooks remain available and fail open when telemetry is unavailable.
  }

  function enqueueEvent(event) {
    if (stopping || !authKey) return false;
    let acknowledge;
    const appended = event.eventType === "HarnessMetrics" ? new Promise((resolve) => { acknowledge = resolve; }) : undefined;
    const priority = isPriorityEvent(event, coalescing.preserveLabels);
    // Reserve one admission for a future global queueFull summary while raw
    // non-priority telemetry is filling the queue. The reservation prevents a
    // full raw queue plus its required accounting summary from exceeding the
    // configured retention bound after the worker drains.
    const capacity = !priority && maxQueueSize > 1 ? maxQueueSize - 1 : maxQueueSize;
    if (queue.length + (worker ? 1 : 0) >= capacity) {
      const evict = priority ? queue.findIndex((queued) => !isPriorityEvent(queued.event, coalescing.preserveLabels)) : -1;
      if (evict >= 0) {
        queue.splice(evict, 1).forEach((queued) => queued.acknowledge?.(false));
        if (event.eventType === "HarnessMetrics") {
          // The evicted event is being counted from inside the coalescer's
          // own flush()/tryEmit call: calling back into it synchronously here
          // would reenter its still-iterating bucket state. Defer the count
          // to a microtask so it lands after that call stack unwinds.
          queueMicrotask(() => {
            try {
              coalescer.recordQueueFull({ replacePending: true });
              void coalescer.flush().catch(() => {});
            } catch { /* Telemetry is fail-open. */ }
          });
          // The rejected snapshot is restored with queueFull by the deferred
          // callback above and retried after the worker frees capacity.
          acknowledge?.(false);
          return false;
        } else {
          try { coalescer.recordQueueFull(); } catch { /* Telemetry is fail-open. */ }
        }
      }
      else {
        if (event.eventType !== "HarnessMetrics") {
          try { coalescer.recordQueueFull(); } catch { /* Telemetry is fail-open. */ }
        }
        acknowledge?.(false);
        return false;
      }
    }
    queue.push({ event, acknowledge });
    startWorker();
    return appended ?? true;
  }

  // A coalescer retry (e.g. the deferred HarnessMetrics re-emission below)
  // can enqueue a new item from within the ack microtask that settles the
  // very `worker` promise this checks, after processQueue()'s loop has
  // already observed an empty queue and exited but before its `finally`
  // clears `worker`. Re-checking the queue there (rather than only guarding
  // start on a stale-but-still-truthy `worker`) closes that race so a queued
  // item never sits unprocessed.
  function startWorker() {
    if (worker) return;
    worker = processQueue().finally(() => {
      worker = undefined;
      if (queue.length > 0) startWorker();
    });
  }

  const coalescer = createEventCoalescer({
    authKey,
    enabled: coalescing.enabled,
    windowMs: coalescing.windowMs,
    queueMax: coalescing.queueMax,
    preserveLabels: coalescing.preserveLabels,
    dlpOverride: coalescing.dlpOverride,
    retentionEpoch,
    enqueue: enqueueEvent,
  });

  function enqueue(input, lifecycleEvent, hookArguments) {
    if (disposed || !authKey) return;
    const type = lifecycleEvent ?? ownString(input, "eventType") ?? ownString(input, "type");
    const scanGlobalNoise = !coalescing.enabled && isGlobalNoise(type);
    // Avoid invoking payload accessors when the raw queue itself is full. The
    // coalescer records this loss without inspecting the rejected payload.
    // Disabled coalescing still translates known global noise so a DLP decision
    // can receive priority; safe global noise is dropped by the coalescer.
    if (!scanGlobalNoise && queue.length >= maxQueueSize) {
      try { coalescer.recordQueueFull(); } catch { /* Telemetry is fail-open. */ }
      return;
    }
    try {
      // Enabled coalescing must translate and scan before admission: a DLP
      // decision receives priority even when ordinary telemetry is saturated.
      const event = translateOpenCodeEvent(input, { authKey, directory, worktree, lifecycleEvent, occurrenceID: randomUUID(), hookArguments, retentionEpoch });
      coalescer.push(event);
    } catch {
      // Shadow telemetry must never affect OpenCode host operations.
      if (queue.length + (worker ? 1 : 0) >= maxQueueSize) {
        try { coalescer.recordQueueFull(); } catch { /* Telemetry is fail-open. */ }
      }
    }
  }

  // Drains accumulated grounding metadata on its own unref'd cadence and
  // enqueues one closed GroundingInjection event per drained { metadata,
  // occurrenceID } entry. This is the ONLY place grounding telemetry is
  // emitted -- the system.transform hot path never enqueues telemetry
  // directly, keeping that hook zero-I/O. Each entry's occurrenceID (minted
  // per injection by the grounding cache) is forwarded so that repeated
  // occurrences of identical metadata content still get distinct
  // eventID/dedupeKey pairs instead of colliding in the ledger's dedupe
  // index. A bare metadata entry (no occurrenceID) falls back to the prior
  // content-only identity.
  function scheduleGroundingDrain() {
    groundingTimer = setTimeout(() => {
      try {
        for (const entry of groundingCache.drainMetadata?.() ?? []) {
          try {
            const { metadata, occurrenceID } = entry && typeof entry === "object" && "metadata" in entry ?
              entry : { metadata: entry, occurrenceID: undefined };
            enqueueEvent(buildGroundingEvent(metadata, { hmacKey: authKey, retentionEpoch: retentionEpoch ?? utcMonth(), occurrenceID }));
          } catch { /* Fail open: malformed grounding metadata must not affect the host. */ }
        }
      } catch { /* Fail open: grounding telemetry must never affect host operations. */ }
      if (!disposed) scheduleGroundingDrain();
    }, GROUNDING_DRAIN_INTERVAL_MS);
    groundingTimer.unref?.();
  }
  scheduleGroundingDrain();

  async function send(method, params, id) {
    const controller = new AbortController();
    activeRequests.add(controller);
    try {
      await request({ socketPath: process.env.AGENT_HARNESS_SOCKET, authKey, timeout: REQUEST_TIMEOUT, method, params, id, signal: controller.signal });
    } finally {
      activeRequests.delete(controller);
    }
  }

  async function processQueue() {
    while (!stopping && queue.length > 0) {
      const queued = queue.shift();
      const { event } = queued;
      let appended = false;
      try {
        await send("ensureRun", { runID: event.runID }, `ensure:${event.runID}`);
        if (!stopping) {
          await send("append", { event }, `append:${event.dedupeKey}`);
          appended = true;
        }
      } catch {
        // Shadow telemetry must never affect OpenCode host operations.
      } finally {
        queued.acknowledge?.(appended);
      }
    }
  }

  // Waits for the in-flight worker to drain within DISPOSE_TIMEOUT. A worker
  // that overruns the bound is treated as stalled: pending raw events are
  // dropped and the in-flight request is aborted so dispose() never blocks
  // the host beyond the timeout contract. Returns whether the wait timed out.
  // When recordDrop is set (there is already coalescer state worth a bounded
  // retry connection), a dropped non-empty queue also counts one queueFull
  // loss so that loss surfaces in the retried HarnessMetrics summary instead
  // of vanishing silently.
  async function drainWorker({ recordDrop = false } = {}) {
    if (!worker) return false;
    let timer;
    const timedOut = await Promise.race([
      worker.then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), DISPOSE_TIMEOUT);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      stopping = true;
      if (recordDrop && queue.length > 0) {
        try { coalescer.recordQueueFull(); } catch { /* Telemetry is fail-open. */ }
      }
      while (queue.length > 0) queue.shift().acknowledge?.(false);
      for (const controller of activeRequests) controller.abort();
      await worker;
    }
    return timedOut;
  }

  return {
    event({ event } = {}) { enqueue(event); },
    "tool.execute.before"(input = {}, output = {}) { enqueue(input, "tool.execute.before", [input, output]); },
    "tool.execute.after"(input = {}, output = {}) {
      enqueue(input, "tool.execute.after", [input, output]);
      try {
        groundingCache.noteToolActivity?.();
      } catch { /* Grounding activity tracking is fail-open. */ }
    },
    // Hot path: synchronous, zero I/O, no socket writes. The hook reads the
    // already-warmed (or cold/null) cache snapshot and injects it verbatim
    // via output.system array. The snapshot's brief is already redacted
    // (fail-secure) by the background warmer in grounding.mjs before it is
    // ever stored, so no redaction runs here -- redactText is a DLP regex
    // scan whose cost scales with brief size and must not run on the model
    // hot path. Telemetry for the injection is drained later by
    // scheduleGroundingDrain on its own unref'd timer, never enqueued here.
    "experimental.chat.system.transform"(input = {}, output = {}) {
      try {
        const snapshot = groundingCache.snapshot?.();
        if (snapshot && snapshot.brief && Array.isArray(output.system)) {
          output.system.push(snapshot.brief);
          try {
            groundingCache.recordInjection?.();
          } catch { /* recordInjection failure is fail-open. */ }
        }
      } catch { /* Grounding injection must never affect host chat rendering. */ }
    },
    async dispose() {
      disposed = true;
      clearTimeout(groundingTimer);
      try { groundingCache.stop?.(); } catch { /* Grounding cache stop is fail-open. */ }
      try {
        // Dispose first to cancel the aggregation timer and put all completed
        // summaries through normal bounded admission before draining.
        let pending = [];
        try { pending = await coalescer.dispose(); } catch { /* Telemetry is fail-open. */ }
        const timedOut = await drainWorker({ recordDrop: pending.length > 0 });
        // Summaries rejected while the queue was full remain retryable in the
        // coalescer, even when the drain above overran DISPOSE_TIMEOUT and
        // dropped the raw queue. Re-open admission just long enough to retry
        // them once now that capacity is freed, then drain the resulting
        // work under the same bound before returning, so a worker timeout
        // never silently discards pending session/global summaries.
        if (timedOut) stopping = false;
        await Promise.resolve();
        try { await coalescer.flush(); } catch { /* Telemetry is fail-open. */ }
        await drainWorker();
      } finally {
        stopping = true;
        try { await coalescer.dispose(); } catch { /* Telemetry is fail-open. */ }
        while (queue.length > 0) queue.shift().acknowledge?.(false);
        for (const controller of activeRequests) controller.abort();
        authKey?.fill(0);
        authKey = undefined;
      }
    },
  };
}

export { OpenCodeShadow };
