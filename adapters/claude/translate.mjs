import { createHmac } from "node:crypto";
import { types } from "node:util";

import { scanText } from "../../src/dlp/classify.mjs";
import { createDecision } from "../../src/protocol/decision.mjs";
import { createEvent } from "../../src/protocol/event.mjs";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const CANONICAL_TOOL_NAMES = new Set(["Bash", "Edit", "Glob", "Grep", "Read", "Task", "WebFetch", "WebSearch", "Write"]);
const SUPPORTED_HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
  "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure",
  "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "ConfigChange",
  "WorktreeCreate", "WorktreeRemove", "TaskCompleted", "TeammateIdle",
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
  let copy;
  if (Array.isArray(value)) {
    copy = [];
    for (const field of Reflect.ownKeys(value)) {
      if (field === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (typeof field !== "string" || !/^(0|[1-9]\d*)$/.test(field) || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("payload must contain only JSON values and no accessors");
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("payload must contain only JSON values");
      copy.push(cloneJSON(Object.getOwnPropertyDescriptor(value, String(index)).value, seen));
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("payload must be a plain JSON object");
    copy = {};
    for (const field of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (typeof field !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("payload must contain only JSON values and no accessors");
      }
      Object.defineProperty(copy, field, {
        value: cloneJSON(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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

function optionalString(payload, field) {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be a nonempty string`);
  return value;
}

export function claudeRunID(sessionID, authKey) {
  if (!Buffer.isBuffer(authKey) || authKey.byteLength < 32) throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  if (typeof sessionID !== "string" || sessionID.trim().length === 0) throw new TypeError("session_id must be a nonempty string");
  return hmac(authKey, "claude.run", sessionID);
}

export function translateClaudeHook(payload, { authKey, now = new Date(), occurrenceID } = {}) {
  if (!Buffer.isBuffer(authKey) || authKey.byteLength < 32) throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  const copy = cloneJSON(payload);
  if (copy === null || Array.isArray(copy) || typeof copy !== "object") throw new TypeError("payload must be a plain JSON object");
  const canonical = canonicalJSON(copy);
  if (Buffer.byteLength(canonical) > MAX_PAYLOAD_BYTES) throw new RangeError("payload exceeds size limit");

  const sessionID = optionalString(copy, "session_id");
  const eventType = optionalString(copy, "hook_event_name");
  if (!sessionID || !eventType) throw new TypeError("payload requires session_id and hook_event_name");
  if (!SUPPORTED_HOOK_EVENTS.has(eventType)) throw new TypeError("unsupported hook_event_name");
  const agentID = optionalString(copy, "agent_id");
  const parentID = optionalString(copy, "parent_session_id") ?? optionalString(copy, "parent_agent_id") ?? (agentID ? sessionID : undefined);
  const cwd = optionalString(copy, "cwd");
  const toolName = optionalString(copy, "tool_name");
  const toolUseID = optionalString(copy, "tool_use_id");
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const occurrence = toolUseID ?? occurrenceID ?? hmac(authKey, "claude.payload", canonical);
  const identity = `${eventType}\0${occurrence}`;
  const ruleIDs = [...new Set(scanText(canonical).map(({ ruleID }) => `dlp.${ruleID}`))].sort();

  return createEvent({
    schemaVersion: 1,
    platform: "claude",
    adapterVersion: "1",
    runID: claudeRunID(sessionID, authKey),
    sessionHMAC: hmac(authKey, "claude.session", agentID ?? sessionID),
    eventID: hmac(authKey, "claude.event", identity),
    dedupeKey: hmac(authKey, "claude.dedupe", identity),
    eventType,
    timestamp,
    ...(parentID ? { parentSessionHMAC: hmac(authKey, "claude.session", parentID) } : {}),
    ...(toolName ? { toolName: CANONICAL_TOOL_NAMES.has(toolName) ? toolName : hmac(authKey, "claude.tool", toolName) } : {}),
    ...(cwd ? { worktreeID: hmac(authKey, "claude.cwd", cwd) } : {}),
    ...(ruleIDs.length > 0 ? { decision: createDecision({
      schemaVersion: 1,
      action: "observe",
      ruleIDs,
      reason: "Credential-shaped content was observed",
    }) } : {}),
  });
}
