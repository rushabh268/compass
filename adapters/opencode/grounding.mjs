import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as promiseFS from "node:fs/promises";
import { redactText } from "../../src/dlp/redact.mjs";
import { collectGrounding, loadGroundingConfig } from "../../src/grounding.mjs";
export { buildBrief, matchInitiative, loadGroundingConfig, collectGrounding } from "../../src/grounding.mjs";
const execFile = promisify(execFileCallback);
const WARM_INTERVAL_MS = 60_000;
const TOOL_ACTIVITY_WARM_DELAY_MS = 1_000;
const MAX_RING_SIZE = 256;

export function createGroundingCache({
  directory,
  worktree,
  notesDir = process.env.AGENT_HARNESS_NOTES_DIR ?? "",
  loadConfig = loadGroundingConfig,
  clock = { now: () => Date.now() },
  timers = { setTimeout, clearTimeout },
  git = { execFile },
  fs = promiseFS,
  redact = redactText,
} = {}) {
  let timer;
  let activityTimer;
  let controller;
  let inFlightWarm;
  let rerunRequested = false;
  let warmingGeneration = 0;
  let committedGeneration = 0;
  let current;
  let previousFingerprint;
  let revision = 0;
  let started = false;
  let stopped = false;
  const metadataRing = new Array(MAX_RING_SIZE);
  let metadataStart = 0;
  let metadataSize = 0;

  function clearSnapshot() {
    current = undefined;
    // A failed refresh must allow unchanged inputs to rebuild the lost snapshot.
    previousFingerprint = undefined;
  }

  function addMetadata(metadata, occurrenceID) {
    const entry = { metadata, occurrenceID };
    if (metadataSize < MAX_RING_SIZE) {
      metadataRing[(metadataStart + metadataSize) % MAX_RING_SIZE] = entry;
      metadataSize += 1;
      return;
    }
    metadataRing[metadataStart] = entry;
    metadataStart = (metadataStart + 1) % MAX_RING_SIZE;
  }

  async function warm(generation) {
    let warmingController;
    try {
      if (stopped) return;
      warmingController = new AbortController();
      controller = warmingController;
      const result = await collectGrounding({ worktree, notesDir, loadConfig, git, fs, redact, signal: warmingController.signal });
      if (stopped || warmingController.signal.aborted || generation < committedGeneration) return;
      if (!result) {
        committedGeneration = generation;
        clearSnapshot();
        return;
      }
      if (result.fingerprint === previousFingerprint) return;
      previousFingerprint = result.fingerprint;
      committedGeneration = generation;
      revision += 1;
      current = Object.freeze({
        revision,
        brief: result.brief,
        metadata: Object.freeze(result.metadata),
      });
    } catch {
      if (!stopped && (!warmingController || !warmingController.signal.aborted) && generation >= committedGeneration) {
        committedGeneration = generation;
        clearSnapshot();
      }
    }
  }

  function requestWarm() {
    if (stopped) return Promise.resolve();
    if (inFlightWarm) {
      rerunRequested = true;
      return Promise.resolve();
    }
    const warmPromise = warm(++warmingGeneration);
    inFlightWarm = warmPromise;
    void warmPromise.then(() => {
      if (inFlightWarm !== warmPromise) return;
      inFlightWarm = undefined;
      if (!stopped && rerunRequested) {
        rerunRequested = false;
        void requestWarm();
      }
    });
    return warmPromise;
  }

  function schedule() {
    if (stopped || timer) return;
    timer = timers.setTimeout(async () => {
      timer = undefined;
      await requestWarm();
      schedule();
    }, WARM_INTERVAL_MS);
    timer?.unref?.();
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      queueMicrotask(() => { void requestWarm(); });
      schedule();
    },
    stop() {
      stopped = true;
      controller?.abort();
      rerunRequested = false;
      if (timer) timers.clearTimeout(timer);
      if (activityTimer) timers.clearTimeout(activityTimer);
      timer = undefined;
      activityTimer = undefined;
    },
    snapshot() {
      return current ?? null;
    },
    noteToolActivity() {
      if (stopped || activityTimer) return;
      activityTimer = timers.setTimeout(async () => {
        activityTimer = undefined;
        await requestWarm();
      }, TOOL_ACTIVITY_WARM_DELAY_MS);
      activityTimer?.unref?.();
    },
    recordInjection(occurrenceID) {
      if (!current) return;
      addMetadata(current.metadata, occurrenceID ?? randomUUID());
    },
    drainMetadata() {
      const drained = new Array(metadataSize);
      for (let index = 0; index < metadataSize; index += 1) drained[index] = metadataRing[(metadataStart + index) % MAX_RING_SIZE];
      metadataStart = 0;
      metadataSize = 0;
      return drained;
    },
  };
}
