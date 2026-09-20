import assert from "node:assert/strict";
import test from "node:test";

import { assertSupportedRuntime } from "../src/runtime.mjs";

test("accepts supported Node 24 versions", () => {
  assert.doesNotThrow(() => assertSupportedRuntime("24.19.0"));
  assert.doesNotThrow(() => assertSupportedRuntime("24.99.1"));
});

test("rejects Node versions below 24.19 and Node 25 or newer", () => {
  assert.throws(() => assertSupportedRuntime("24.18.9"), /Node\.js 24\.19 or newer.*below 25/i);
  assert.throws(() => assertSupportedRuntime("23.99.0"), /Node\.js 24\.19 or newer.*below 25/i);
  assert.throws(() => assertSupportedRuntime("25.0.0"), /Node\.js 24\.19 or newer.*below 25/i);
});

test("rejects malformed version strings clearly", () => {
  for (const version of ["24.19", "v24.19.0", "24.19.0-beta", "banana", "", null]) {
    assert.throws(() => assertSupportedRuntime(version), /invalid Node\.js version/i);
  }
});
