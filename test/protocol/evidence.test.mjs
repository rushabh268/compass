import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  authenticateRequest,
  encodeFrame,
  FrameDecoder,
} from "../../src/protocol/rpc.mjs";
import { evidenceIdentity } from "../../src/identity.mjs";
test("public synthetic reader fixtures authenticate and decode at every frame split", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/conductor/protocol-v1.json", import.meta.url),
      "utf8",
    ),
  );
  for (const item of fixture.requests) {
    assert.equal(
      authenticateRequest(
        item.request,
        Buffer.from(fixture.readerKeyHex, "hex"),
      ),
      true,
    );
    assert.equal(encodeFrame(item.request).toString("hex"), item.frameHex);
    assert.deepEqual(
      evidenceIdentity(
        item.request.params,
        Buffer.from(fixture.syntheticWriterKeyHex, "hex"),
      ),
      item.identity,
    );
    const bytes = Buffer.from(item.frameHex, "hex");
    for (let split = 1; split < bytes.length; split++) {
      const decoder = new FrameDecoder();
      assert.deepEqual(
        [
          ...decoder.push(bytes.subarray(0, split)),
          ...decoder.push(bytes.subarray(split)),
        ],
        [item.request],
      );
    }
  }
});
test("selectors reject malformed identities and platform-invalid subject kinds", () => {
  const key = Buffer.alloc(32, 7);
  for (const params of [
    { version: 2, platform: "claude", rootSessionID: "x" },
    {
      version: 1,
      platform: "claude",
      rootSessionID: "x",
      subject: { kind: "session", nativeID: "y" },
    },
    {
      version: 1,
      platform: "opencode",
      rootSessionID: "x",
      subject: { kind: "agent", nativeID: "y" },
    },
    {
      version: 1,
      platform: "codex",
      rootSessionID: "x",
      subject: { kind: "root", nativeID: "y" },
    },
    { version: 1, platform: "claude", rootSessionID: "x".repeat(1025) },
    {
      version: 1,
      platform: "claude",
      rootSessionID: "x",
      subject: { kind: "root", nativeID: "x", extra: true },
    },
  ])
    assert.throws(() => evidenceIdentity(params, key));
});
