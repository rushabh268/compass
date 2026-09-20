#!/usr/bin/env node
import { environmentValue } from "../../src/environment.mjs";
import { readAuthKeyFile } from "../../src/paths.mjs";
import { request } from "../../src/supervisor/client.mjs";
import { claudeRunID, translateClaudeHook } from "./translate.mjs";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

const MAX_STDIN_BYTES = 1024 * 1024;

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new RangeError("input exceeds size limit");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

async function main() {
  let authKey;
  try {
    const payload = await readInput();
    authKey = await readAuthKeyFile(environmentValue("KEY_FILE"));
    const options = { socketPath: environmentValue("SOCKET"), authKey, timeout: 1_000 };
    const runID = claudeRunID(payload?.session_id, authKey);
    await request({ ...options, method: "ensureRun", params: { runID }, id: `ensure:${runID}` });
    const event = translateClaudeHook(payload, { authKey, occurrenceID: randomUUID() });
    await request({ ...options, method: "append", params: { event }, id: `append:${event.dedupeKey}` });
  } catch {
    // Cooperative shadow hooks must never interrupt or write into the host session.
  } finally {
    authKey?.fill(0);
  }
}

await main();
