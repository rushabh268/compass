#!/usr/bin/env node
import { TextDecoder } from "node:util";

import { readAuthKeyFile } from "../../src/paths.mjs";
import { request } from "../../src/supervisor/client.mjs";
import { MAX_CODEX_PAYLOAD_BYTES, translateCodexHook } from "./translate.mjs";

const HOOK_DEADLINE_MS = 1_000;

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_CODEX_PAYLOAD_BYTES) throw new RangeError("input exceeds size limit");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

async function main() {
  let authKey;
  const controller = new AbortController();
  const deadlineAt = performance.now() + HOOK_DEADLINE_MS;
  const deadline = setTimeout(() => {
    controller.abort();
    process.stdin.destroy();
    authKey?.fill(0);
    // This is a one-shot telemetry process. Even an unfinished filesystem read
    // or stdin producer must not keep a synchronous SessionEnd hook alive.
    process.exit(0);
  }, HOOK_DEADLINE_MS);
  const remaining = () => {
    const timeout = deadlineAt - performance.now();
    if (timeout <= 0) throw new Error("hook deadline reached");
    return timeout;
  };
  try {
    const payload = await readInput();
    authKey = await readAuthKeyFile(process.env.AGENT_HARNESS_KEY_FILE);
    // Validate before ensureRun: malformed or unsupported callbacks create no state.
    const event = translateCodexHook(payload, { authKey });
    const options = {
      socketPath: process.env.AGENT_HARNESS_SOCKET,
      authKey,
      signal: controller.signal,
    };
    await request({
      ...options, timeout: remaining(), method: "ensureRun",
      params: { runID: event.runID }, id: "codex:ensure:" + event.runID,
    });
    await request({
      ...options, timeout: remaining(), method: "append",
      params: { event }, id: "codex:append:" + event.dedupeKey,
    });
  } catch {
    // Empty stdout/stderr and exit 0 never supply a Codex decision or context.
  } finally {
    clearTimeout(deadline);
    controller.abort();
    process.stdin.destroy();
    authKey?.fill(0);
  }
}

await main();
