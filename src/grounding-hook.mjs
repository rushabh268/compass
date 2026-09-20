#!/usr/bin/env node
import { environmentValue } from "./environment.mjs";
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectGrounding } from './grounding.mjs';
import { buildGroundingEvent, utcMonth } from './grounding-event.mjs';
import { readAuthKeyFile } from './paths.mjs';
import { request } from './supervisor/client.mjs';

const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_BRIEF_BYTES = 8192;

async function readInput(input, signal) {
  const abort = () => input.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of input) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) throw Error('input exceeds limit');
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', abort); }
}

// Context delivery is independent of audit availability. The audit records only
// delivery to the host; it makes no claim about a later model execution.
export async function runGroundingHook({ platform, input = process.stdin, output = process.stdout } = {}) {
  const controller = new AbortController();
  const started = performance.now();
  const deadline = setTimeout(() => controller.abort(), 900);
  let authKey;
  try {
    if (!['claude', 'codex'].includes(platform)) return;
    const payload = await readInput(input, controller.signal);
    if (!EVENTS.has(payload?.hook_event_name) || typeof payload.cwd !== 'string' || !isAbsolute(payload.cwd)) return;
    const result = await collectGrounding({ worktree: payload.cwd, signal: controller.signal, maxBytes: MAX_BRIEF_BYTES });
    if (!result || controller.signal.aborted) return;
    const envelope = { hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: result.brief } };
    await new Promise((resolve, reject) => output.write(JSON.stringify(envelope) + '\n', (error) => error ? reject(error) : resolve()));
    const remaining = Math.min(100, 900 - (performance.now() - started));
    if (remaining <= 0) return;
    const auditTimer = setTimeout(() => controller.abort(), remaining);
    try {
      authKey = await readAuthKeyFile(environmentValue("KEY_FILE"));
      controller.signal.throwIfAborted();
      const event = buildGroundingEvent(result.metadata, { platform, hmacKey: authKey, retentionEpoch: utcMonth(), occurrenceID: randomUUID() });
      const options = { socketPath: environmentValue("SOCKET"), authKey, timeout: remaining, signal: controller.signal };
      await request({ ...options, method: 'ensureRun', params: { runID: event.runID }, id: `ensure:${event.runID}` });
      await request({ ...options, method: 'append', params: { event }, id: `append:${event.dedupeKey}` });
    } finally { clearTimeout(auditTimer); }
  } catch {
    // Optional grounding must never interrupt the native host.
  } finally {
    controller.abort();
    clearTimeout(deadline);
    authKey?.fill(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  // Hard process boundary also covers stuck filesystem callbacks and output.
  const watchdog = setTimeout(() => process.exit(0), Math.max(1, 1000 - process.uptime() * 1000));
  const index = process.argv.indexOf('--platform');
  await runGroundingHook({ platform: index >= 0 ? process.argv[index + 1] : undefined });
  clearTimeout(watchdog);
}
