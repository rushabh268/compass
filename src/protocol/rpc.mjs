import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";

export const MAX_FRAME_BYTES = 1024 * 1024;

const requestFields = new Set(["version", "id", "method", "params", "auth"]);
const responseFields = new Set(["version", "id", "result", "error"]);
const errorFields = new Set(["code", "message"]);

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.byteLength < 32) {
    throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  }
}

function assertRecord(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain JSON object`);
  }
  for (const field of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (typeof field !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${name} must not contain accessors or symbols`);
    }
  }
}

function assertClosed(value, allowed, name) {
  assertRecord(value, name);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`unknown field: ${field}`);
  }
}

function cloneJSON(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("value must contain only JSON values");
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value)) throw new TypeError("value must contain only JSON values and no proxies");
  if (seen.has(value)) throw new TypeError("value must contain only JSON values");
  seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = [];
    for (const field of Reflect.ownKeys(value)) {
      if (field === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (typeof field !== "string" || !/^(0|[1-9]\d*)$/.test(field) || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("value must contain only JSON values and no accessors");
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("value must contain only JSON values");
      copy.push(cloneJSON(Object.getOwnPropertyDescriptor(value, String(index)).value, seen));
    }
  } else {
    assertRecord(value, "value");
    copy = {};
    for (const field of Object.keys(value)) {
      Object.defineProperty(copy, field, {
        value: cloneJSON(Object.getOwnPropertyDescriptor(value, field).value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function assertString(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new TypeError(`${field} must be a nonempty string of at most 1024 characters`);
  }
}

function canonicalBody({ version, id, method, params }) {
  return canonicalJSON({ version, id, method, params });
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestMAC(request, key) {
  return createHmac("sha256", key).update(canonicalBody(request)).digest();
}

function validateRequest(input) {
  assertClosed(input, requestFields, "request");
  if (input.version !== 1) throw new TypeError("version must be 1");
  assertString(input.id, "id");
  assertString(input.method, "method");
  assertRecord(input.params, "params");
  const params = cloneJSON(input.params);
  if (typeof input.auth !== "string" || !/^[0-9a-f]{64}$/.test(input.auth)) throw new TypeError("auth must be a SHA-256 HMAC");
  return { version: 1, id: input.id, method: input.method, params, auth: input.auth };
}

export function createRequest(input) {
  assertClosed(input, new Set(["id", "method", "params", "authKey"]), "request options");
  assertKey(input.authKey);
  assertString(input.id, "id");
  assertString(input.method, "method");
  assertRecord(input.params, "params");
  const params = cloneJSON(input.params);
  const unsigned = { version: 1, id: input.id, method: input.method, params };
  return Object.freeze({ ...unsigned, auth: requestMAC(unsigned, input.authKey).toString("hex") });
}

export function authenticateRequest(input, authKey) {
  assertKey(authKey);
  const request = validateRequest(input);
  const supplied = Buffer.from(request.auth, "hex");
  return supplied.length === 32 && timingSafeEqual(supplied, requestMAC(request, authKey));
}

export function parseRequest(input) {
  return Object.freeze(validateRequest(input));
}

export function createResponse(input) {
  assertClosed(input, new Set(["id", "result", "error"]), "response options");
  assertString(input.id, "id");
  const hasResult = Object.hasOwn(input, "result");
  const hasError = Object.hasOwn(input, "error");
  if (hasResult === hasError) throw new TypeError("response must contain exactly one of result or error");
  if (hasError) {
    assertClosed(input.error, errorFields, "error");
    assertString(input.error.code, "error.code");
    assertString(input.error.message, "error.message");
  }
  const payload = hasResult ? { result: cloneJSON(input.result) } : { error: cloneJSON(input.error) };
  return Object.freeze({ version: 1, id: input.id, ...payload });
}

export function parseResponse(input) {
  assertClosed(input, responseFields, "response");
  if (input.version !== 1) throw new TypeError("version must be 1");
  return createResponse({ id: input.id, ...(Object.hasOwn(input, "result") ? { result: input.result } : {}), ...(Object.hasOwn(input, "error") ? { error: input.error } : {}) });
}

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(cloneJSON(value)), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new RangeError("frame exceeds 1 MiB limit");
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  #header = Buffer.allocUnsafe(4);
  #headerBytes = 0;
  #body = null;
  #bodyBytes = 0;

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new TypeError("frame chunk must be bytes");
    const values = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#body === null) {
        const copied = Math.min(4 - this.#headerBytes, chunk.length - offset);
        this.#header.set(chunk.subarray(offset, offset + copied), this.#headerBytes);
        this.#headerBytes += copied;
        offset += copied;
        if (this.#headerBytes < 4) break;
        const length = this.#header.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) throw new RangeError("frame exceeds 1 MiB limit");
        this.#body = Buffer.allocUnsafe(length);
        this.#bodyBytes = 0;
      }
      const copied = Math.min(this.#body.length - this.#bodyBytes, chunk.length - offset);
      this.#body.set(chunk.subarray(offset, offset + copied), this.#bodyBytes);
      this.#bodyBytes += copied;
      offset += copied;
      if (this.#bodyBytes < this.#body.length) break;
      try {
        values.push(JSON.parse(this.#body.toString("utf8")));
      } catch {
        throw new TypeError("frame contains invalid JSON");
      }
      this.#headerBytes = 0;
      this.#body = null;
      this.#bodyBytes = 0;
    }
    return values;
  }

  end() {
    if (this.#headerBytes !== 0 || this.#body !== null) throw new Error("truncated frame");
  }
}
