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
  const worker = new Worker(workerURL, {
    workerData: { path, key, snapshotTTL },
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  const jobs = new Map();
  let sequence = 0,
    closed = false;
  function fail() {
    closed = true;
    for (const job of jobs.values()) {
      clearTimeout(job.timer);
      job.resolve(unavailable);
    }
    jobs.clear();
  }
  worker.on("error", fail);
  worker.on("exit", fail);
  worker.on("message", ({ id, result }) => {
    const job = jobs.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    jobs.delete(id);
    job.resolve(result);
  });
  function submit(method, params) {
    if (closed) return Promise.resolve(unavailable);
    if (jobs.size >= maxJobs)
      return Promise.resolve({ version: 1, state: "resource_exhausted" });
    const id = ++sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        fail();
        void worker.terminate();
      }, timeout);
      jobs.set(id, { resolve, timer });
      worker.postMessage({ id, method, params });
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
    async close() {
      fail();
      await worker.terminate();
    },
  };
}
