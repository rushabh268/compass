import { Worker } from "node:worker_threads";
import { evidenceIdentity } from "../identity.mjs";
const unavailable = { version: 1, state: "unavailable" };
export function createEvidenceService({
  path,
  key,
  maxJobs = 8,
  timeout = 5000,
  snapshotTTL = 60000,
  workerURL = new URL("./worker.mjs", import.meta.url),
  workerFactory = (url, options) => new Worker(url, options),
} = {}) {
  if (
    !Number.isSafeInteger(maxJobs) ||
    maxJobs < 1 ||
    maxJobs > 8 ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000 ||
    !Number.isSafeInteger(snapshotTTL) ||
    snapshotTTL < 1 ||
    snapshotTTL > 60000
  )
    throw new TypeError("invalid evidence limits");
  const waiting = [];
  const terminations = new Set();
  let generation = null;
  let sequence = 0;
  let closed = false;
  let closing;

  function terminate(worker) {
    if (!worker) return;
    // Keep failures local, but retain every termination until close can await it.
    const pending = Promise.resolve().then(() => worker.terminate()).catch(() => {});
    terminations.add(pending);
    void pending.then(() => terminations.delete(pending));
  }
  function settle(job, result) {
    clearTimeout(job.timer);
    job.resolve(result);
  }
  function fail(current) {
    if (generation !== current) return;
    generation = null;
    if (current.active) settle(current.active, unavailable);
    current.active = null;
    for (const job of waiting.splice(0)) settle(job, unavailable);
    terminate(current.worker);
  }
  function dispatch() {
    if (closed || !waiting.length || generation?.active) return;
    if (!generation) {
      const current = { worker: null, active: null };
      generation = current;
      try {
        current.worker = workerFactory(workerURL, {
          workerData: { path, key, snapshotTTL },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        });
        current.worker.on("error", () => fail(current));
        current.worker.on("exit", () => fail(current));
        current.worker.on("message", ({ id, result }) => {
          if (generation !== current || current.active?.id !== id) return;
          const job = current.active;
          current.active = null;
          settle(job, result);
          dispatch();
        });
      } catch {
        fail(current);
        return;
      }
    }
    const current = generation;
    const job = waiting.shift();
    current.active = job;
    // Queue wait never consumes a running verifier's execution budget. Total
    // admission is bounded; each preceding job finishes or fails its watchdog.
    job.timer = setTimeout(() => fail(current), timeout);
    try {
      current.worker.postMessage({ id: job.id, method: job.method, params: job.params });
    } catch {
      fail(current);
    }
  }
  function submit(method, params) {
    if (closed) return Promise.resolve(unavailable);
    if (waiting.length + (generation?.active ? 1 : 0) >= maxJobs)
      return Promise.resolve({ version: 1, state: "resource_exhausted" });
    return new Promise((resolve) => {
      waiting.push({ id: ++sequence, method, params, resolve });
      dispatch();
    });
  }
  return {
    retentionStatus() {
      return submit("retention", {});
    },
    begin(params) {
      return submit("begin", evidenceIdentity(params, key));
    },
    continue(params) {
      if (
        params.version !== 1 ||
        typeof params.cursor !== "string" ||
        Object.keys(params).some((k) => !["version", "cursor"].includes(k))
      )
        throw new TypeError("invalid cursor request");
      return submit("continue", { cursor: params.cursor });
    },
    close() {
      if (!closing) {
        closed = true;
        if (generation) fail(generation);
        closing = Promise.all([...terminations]).then(() => {});
      }
      return closing;
    },
  };
}
