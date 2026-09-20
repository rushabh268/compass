import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  MAX_FRAME_BYTES,
  FrameDecoder,
  authenticateRequest,
  createRequest,
  createResponse,
  encodeFrame,
} from "../../src/protocol/rpc.mjs";

const key = Buffer.alloc(32, 0x5a);

test("creates and authenticates a closed version-1 request", () => {
  const request = createRequest({ id: "request-1", method: "health", params: {}, authKey: key });
  const canonical = '{"id":"request-1","method":"health","params":{},"version":1}';
  assert.deepEqual(request, {
    version: 1,
    id: "request-1",
    method: "health",
    params: {},
    auth: createHmac("sha256", key).update(canonical).digest("hex"),
  });
  assert.equal(authenticateRequest(request, key), true);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.params), true);
});

test("canonical authentication is independent of object key insertion order", () => {
  const first = createRequest({ id: "id", method: "append", params: { z: 1, nested: { b: 2, a: 1 } }, authKey: key });
  const second = createRequest({ id: "id", method: "append", params: { nested: { a: 1, b: 2 }, z: 1 }, authKey: key });
  assert.equal(first.auth, second.auth);
});

test("rejects invalid keys, unknown fields, accessors, proxies, and non-JSON values", () => {
  for (const authKey of ["secret", Buffer.alloc(31), new Uint8Array(32)]) {
    assert.throws(() => createRequest({ id: "id", method: "health", params: {}, authKey }), /Buffer.*32/i);
  }
  assert.throws(() => authenticateRequest({ version: 1, id: "id", method: "health", params: {}, auth: "0".repeat(64), extra: true }, key), /unknown field/i);
  assert.throws(() => createResponse({ id: "id", result: {}, extra: true }), /unknown field/i);
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get() { return "secret"; } });
  for (const params of [accessor, new Proxy({}, {}), { value: undefined }, { value: 1n }, { value: Number.NaN }, { value: () => {} }]) {
    assert.throws(() => createRequest({ id: "id", method: "health", params, authKey: key }), /JSON|plain|accessor|proxy/i);
  }
  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get() { return "secret"; } });
  accessorArray.length = 1;
  assert.throws(() => createRequest({ id: "id", method: "health", params: { values: accessorArray }, authKey: key }), /JSON|accessor/i);
});

test("preserves JSON __proto__ properties without changing object prototypes", () => {
  const params = JSON.parse('{"__proto__":{"polluted":true}}');
  const request = createRequest({ id: "id", method: "health", params, authKey: key });
  assert.equal(Object.getPrototypeOf(request.params), Object.prototype);
  assert.equal(Object.hasOwn(request.params, "__proto__"), true);
  assert.deepEqual(request.params.__proto__, { polluted: true });
});

test("validates closed success and error responses", () => {
  assert.deepEqual(createResponse({ id: "id", result: { ok: true } }), { version: 1, id: "id", result: { ok: true } });
  assert.deepEqual(createResponse({ id: "id", error: { code: "FAILED", message: "request failed" } }), {
    version: 1, id: "id", error: { code: "FAILED", message: "request failed" },
  });
  assert.throws(() => createResponse({ id: "id", result: {}, error: { code: "x", message: "x" } }), /exactly one/i);
});

test("decodes fragmented and coalesced length-prefixed JSON frames", () => {
  const first = encodeFrame({ one: 1 });
  const second = encodeFrame({ two: 2 });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(2), second])), [{ one: 1 }, { two: 2 }]);
  decoder.end();
});

test("enforces the 1 MiB frame cap and rejects truncated or invalid JSON", () => {
  assert.throws(() => encodeFrame("x".repeat(MAX_FRAME_BYTES)), /1 MiB|too large/i);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => new FrameDecoder().push(oversized), /1 MiB|too large/i);
  const decoder = new FrameDecoder();
  decoder.push(Buffer.from([0, 0, 0, 2, 0x7b]));
  assert.throws(() => decoder.end(), /truncated/i);
  assert.throws(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 0x7b])), /JSON/i);
});

test("decodes a large valid frame delivered one byte at a time within a linear budget", { timeout: 10_000 }, () => {
  function decode(size) {
    const value = { payload: "x".repeat(size) };
    const frame = encodeFrame(value);
    const decoder = new FrameDecoder();
    const decoded = [];
    const started = performance.now();
    for (let offset = 0; offset < frame.length; offset += 1) {
      decoded.push(...decoder.push(frame.subarray(offset, offset + 1)));
    }
    const elapsed = performance.now() - started;
    decoder.end();
    assert.deepEqual(decoded, [value]);
    return elapsed;
  }

  const smallElapsed = decode(128 * 1024);
  const largeElapsed = decode(512 * 1024);
  assert.ok(largeElapsed < smallElapsed * 8 + 100,
    `4x input took ${largeElapsed.toFixed(0)}ms after ${smallElapsed.toFixed(0)}ms baseline`);
});
