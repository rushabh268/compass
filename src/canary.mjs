import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { translateClaudeHook } from "../adapters/claude/translate.mjs";
import { translateCodexHook } from "../adapters/codex/translate.mjs";
import { translateOpenCodeEvent } from "../adapters/opencode/translate.mjs";
import { request } from "./supervisor/client.mjs";

function assert(condition) {
  if (!condition) throw new Error("canary check failed");
}

function sentinelCredential() {
  return `Authorization: Bearer ${randomBytes(32).toString("base64url")}`;
}

async function listEventPages({ socketPath, authKey, runID }) {
  const events = [];
  let cursor = 0;
  do {
    const page = await request({
      socketPath,
      authKey,
      method: "listEvents",
      params: { runID, cursor, limit: 1 },
    });
    assert(Array.isArray(page?.events) && page.events.length <= 1);
    events.push(...page.events);
    assert(page.nextCursor === null || (Number.isSafeInteger(page.nextCursor) && page.nextCursor > cursor));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return events;
}

async function scanLedgerBytes(ledgerPath) {
  const contents = [];
  for (const path of [ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
    try {
      contents.push(await readFile(path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return Buffer.concat(contents);
}

function countMatches(bytes, needle) {
  let matches = 0;
  for (let offset = bytes.indexOf(needle); offset !== -1; offset = bytes.indexOf(needle, offset + needle.length)) matches += 1;
  return matches;
}

export async function runCanary({ socketPath, authKey, ledgerPath } = {}) {
  const sentinel = sentinelCredential();
  try {
    const now = new Date();
    const claude = translateClaudeHook({
      session_id: randomUUID(),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: randomUUID(),
      tool_input: sentinel,
    }, { authKey, now });
    const opencode = translateOpenCodeEvent({
      sessionID: randomUUID(),
      eventType: "tool.execute.before",
      tool: "bash",
      callID: randomUUID(),
      arguments: sentinel,
    }, { authKey, now });
    const codex = translateCodexHook({
      session_id: randomUUID(),
      turn_id: randomUUID(),
      cwd: "/synthetic/repository",
      transcript_path: null,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: randomUUID(),
      tool_input: { command: sentinel },
    }, { authKey, now, occurrenceID: randomUUID() });
    const events = [claude, opencode, codex];

    for (const event of events) {
      await request({ socketPath, authKey, method: "ensureRun", params: { runID: event.runID } });
      const receipt = await request({ socketPath, authKey, method: "append", params: { event } });
      assert(receipt?.inserted === true);
    }
    const replay = await request({ socketPath, authKey, method: "append", params: { event: claude } });
    assert(replay?.inserted === false);

    const verification = await request({ socketPath, authKey, method: "verifyAll", params: {} });
    assert(verification?.invalid === 0 && verification.valid >= events.length);

    const listed = (await Promise.all(events.map((event) => listEventPages({ socketPath, authKey, runID: event.runID })))).flat();
    assert(listed.length === events.length);
    assert(new Set(listed.map((event) => event.eventID)).size === events.length);
    assert(new Set(listed.map((event) => event.platform)).size === events.length);
    assert(listed.every((event) => event.decision?.action === "observe"));

    const bytes = await scanLedgerBytes(ledgerPath);
    assert(bytes.length > 0);
    for (const event of events) {
      assert(bytes.includes(Buffer.from(event.eventID)));
      assert(bytes.includes(Buffer.from(event.dedupeKey)));
    }
    const rawMatches = countMatches(bytes, Buffer.from(sentinel));
    assert(rawMatches === 0);
    return Object.freeze({ ok: true, events: events.length, rawSentinelMatches: rawMatches });
  } catch {
    throw new Error("canary failed");
  }
}
