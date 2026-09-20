import { identityHMAC as hmac } from "../../src/identity.mjs";
import { buildGroundingEvent as sharedGroundingEvent } from "../../src/grounding-event.mjs";
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { scanText } from "../../src/dlp/classify.mjs";
import { createDecision } from "../../src/protocol/decision.mjs";
import { createEvent } from "../../src/protocol/event.mjs";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const EVENT_NAMES = new Map([
  ["session.created", "SessionStart"],
  ["session.deleted", "SessionEnd"],
  ["session.idle", "Stop"],
  ["session.error", "StopFailure"],
  ["session.compacted", "PostCompact"],
  ["session.updated", "SessionUpdate"],
  ["session.status", "SessionStatus"],
  ["session.diff", "SessionDiff"],
  ["message.updated", "MessageUpdate"],
  ["message.part.delta", "MessagePartDelta"],
  ["message.removed", "MessageRemove"],
  ["message.part.updated", "MessagePartUpdate"],
  ["message.part.removed", "MessagePartRemove"],
  ["permission.updated", "PermissionRequest"],
  ["permission.replied", "PermissionResponse"],
  ["file.edited", "FileEdit"],
  ["todo.updated", "TodoUpdate"],
  ["command.executed", "CommandExecute"],
  ["installation.updated", "InstallationUpdate"],
  ["lsp.client.diagnostics", "LspDiagnostics"],
  ["lsp.updated", "LspUpdate"],
  ["server.connected", "ServerConnected"],
  ["tui.prompt.append", "TuiPromptAppend"],
  ["tui.command.execute", "TuiCommandExecute"],
  ["tui.toast.show", "TuiToastShow"],
  ["tool.execute.before", "PreToolUse"],
  ["tool.execute.after", "PostToolUse"],
]);
const GLOBAL_NOISE_EVENT_TYPES = new Set([
  "FileEdit", "FileWatcher", "InstallationUpdate", "LspDiagnostics", "LspUpdate", "Pty", "ServerConnected",
  "TuiCommandExecute", "TuiPromptAppend", "TuiToastShow", "Vcs",
]);
const TOOL_NAMES = new Map([
  ["bash", "Bash"], ["edit", "Edit"], ["glob", "Glob"], ["grep", "Grep"],
  ["read", "Read"], ["task", "Task"], ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"], ["write", "Write"], ["apply_patch", "ApplyPatch"],
  ["skill", "Skill"], ["todowrite", "TodoWrite"], ["todoread", "TodoRead"],
]);

function cloneJSON(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("payload must contain only JSON values");
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value)) throw new TypeError("payload must contain only JSON values and no proxies");
  if (seen.has(value)) throw new TypeError("payload must contain only JSON values");
  seen.add(value);
  const copy = Array.isArray(value) ? [] : {};
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("payload must be a plain JSON object");
  for (const field of Reflect.ownKeys(value)) {
    if (field === "length" && Array.isArray(value)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (typeof field !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("payload must contain only JSON values and no accessors");
    }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("payload must contain only JSON values");
      copy.push(cloneJSON(Object.getOwnPropertyDescriptor(value, String(index)).value, seen));
    }
  } else {
    for (const field of Object.keys(value)) {
      Object.defineProperty(copy, field, { value: cloneJSON(value[field], seen), enumerable: true, writable: true, configurable: true });
    }
  }
  seen.delete(value);
  return copy;
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}


function string(value, name, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

function own(value, field) {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) return undefined;
  return Object.getOwnPropertyDescriptor(value, field).value;
}

export function translateOpenCodeEvent(input, {
  authKey, now = new Date(), occurrenceID, directory, worktree, lifecycleEvent, hookArguments, retentionEpoch,
} = {}) {
  if (!Buffer.isBuffer(authKey) || authKey.byteLength < 32) throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  const copy = cloneJSON(input);
  if (copy === null || Array.isArray(copy) || typeof copy !== "object") throw new TypeError("payload must be a plain JSON object");
  const canonical = canonicalJSON(copy);
  if (Buffer.byteLength(canonical) > MAX_PAYLOAD_BYTES) throw new RangeError("payload exceeds size limit");

  const nativeEventType = string(lifecycleEvent ?? own(copy, "eventType") ?? own(copy, "type"), "eventType", true);
  const rawProperties = own(copy, "properties");
  const properties = rawProperties && !Array.isArray(rawProperties) ? rawProperties : {};
  const info = own(copy, "info") ?? own(properties, "info");
  const part = own(copy, "part") ?? own(properties, "part");
  const eventType = nativeEventType.startsWith("pty.") ? "Pty" :
    nativeEventType.startsWith("file.watcher.") ? "FileWatcher" :
    nativeEventType.startsWith("vcs.") ? "Vcs" :
    EVENT_NAMES.get(nativeEventType) ?? hmac(authKey, "opencode.event-type", nativeEventType);
  const globalNoise = GLOBAL_NOISE_EVENT_TYPES.has(eventType);
  const sessionID = string(
    globalNoise ? "global" :
      own(copy, "sessionID") ?? own(properties, "sessionID") ?? own(info, "sessionID") ?? own(part, "sessionID") ??
      (nativeEventType.startsWith("session.") ? own(info, "id") : undefined) ??
      (eventType === "StopFailure" ? "global" : undefined),
    "sessionID",
    true,
  );
  const nativeTool = string(own(copy, "tool") ?? own(copy, "toolName"), "tool");
  const nativeCallID = own(copy, "callID");
  const nativeEventID = string(nativeCallID ?? own(copy, "id"), "event ID");
  const parentID = string(own(info, "parentID") ?? own(info, "parentSessionID"), "parent session ID");
  const directoryValue = string(directory, "directory");
  const worktreeValue = string(worktree, "worktree");
  const retentionEpochValue = string(retentionEpoch, "retentionEpoch");
  const occurrence = nativeEventID ?? string(occurrenceID, "occurrenceID") ?? randomUUID();
  // Sessionless events (global noise and session-less StopFailure) all share
  // the fixed "global" identity domain. Fold an injected retention epoch
  // (e.g. a UTC month) into that domain so global metrics and sessionless
  // global DLP run IDs are time-partitioned: once an epoch's retention
  // window is archived, a later epoch never reuses its runID or event IDs.
  const globalScope = sessionID === "global";
  const scopedSessionID = globalScope && retentionEpochValue ? `${sessionID}:${retentionEpochValue}` : sessionID;
  const identity = globalScope && retentionEpochValue ?
    `${nativeEventType}\0${occurrence}\0${retentionEpochValue}` : `${nativeEventType}\0${occurrence}`;
  const scanCopy = hookArguments === undefined ? copy : cloneJSON(hookArguments);
  const ruleIDs = [...new Set(scanText(canonicalJSON(scanCopy)).map(({ ruleID }) => `dlp.${ruleID}`))].sort();

  return createEvent({
    schemaVersion: 1,
    platform: "opencode",
    adapterVersion: "1",
    runID: hmac(authKey, "opencode.run", scopedSessionID),
    sessionHMAC: hmac(authKey, "opencode.session", scopedSessionID),
    eventID: hmac(authKey, "opencode.event", identity),
    dedupeKey: hmac(authKey, "opencode.dedupe", identity),
    eventType,
    timestamp: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    ...(parentID ? { parentSessionHMAC: hmac(authKey, "opencode.session", parentID) } : {}),
    ...(nativeCallID ? { callID: hmac(authKey, "opencode.call", nativeEventID) } : {}),
    ...(nativeTool ? { toolName: TOOL_NAMES.get(nativeTool.toLowerCase()) ?? hmac(authKey, "opencode.tool", nativeTool) } : {}),
    ...(directoryValue ? { repoID: hmac(authKey, "opencode.directory", directoryValue) } : {}),
    ...(worktreeValue ? { worktreeID: hmac(authKey, "opencode.worktree", worktreeValue) } : {}),
    ...(ruleIDs.length > 0 ? { decision: createDecision({
      schemaVersion: 1,
      action: "observe",
      ruleIDs,
      reason: "Credential-shaped content was observed",
    }) } : {}),
  });
}

// Compatibility wrapper retains the historical metadata-derived identity defaults.
export function buildGroundingEvent(metadata, options = {}) {
  return sharedGroundingEvent(metadata, { ...options, retentionEpoch: options.retentionEpoch ?? "", occurrenceID: options.occurrenceID ?? "", platform: "opencode" });
}
