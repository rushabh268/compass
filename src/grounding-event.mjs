import { createHmac, randomUUID } from "node:crypto";
import { createEvent } from "./protocol/event.mjs";

export function utcMonth(now = new Date()) { return new Date(now).toISOString().slice(0, 7); }

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

// Closed delivery metadata only; explicit occurrence IDs make retries immutable.
export function buildGroundingEvent(metadata, { platform, now = new Date(), hmacKey, retentionEpoch = utcMonth(now), occurrenceID = randomUUID() } = {}) {
  if (!["claude", "codex", "opencode"].includes(platform)) throw new TypeError("unsupported platform");
  if (!Buffer.isBuffer(hmacKey) || hmacKey.byteLength < 32) throw new TypeError("hmacKey must be a Buffer of at least 32 bytes");
  // Scope identity by epoch if provided (guards against archive collisions)
  const groundingScope = retentionEpoch ? `grounding:${retentionEpoch}` : "grounding";
  const identity = `GroundingInjection\0${canonicalJSON(metadata)}${retentionEpoch ? `\0${retentionEpoch}` : ""}${occurrenceID ? `\0${occurrenceID}` : ""}`;
  return createEvent({
    schemaVersion: 1,
    platform,
    runID: hmac(hmacKey, `${platform}.run`, groundingScope),
    sessionHMAC: hmac(hmacKey, `${platform}.session`, groundingScope),
    eventID: hmac(hmacKey, `${platform}.event`, identity),
    dedupeKey: hmac(hmacKey, `${platform}.dedupe`, identity),
    eventType: "GroundingInjection",
    timestamp: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    metadata,
  });
}
