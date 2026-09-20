import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { request } from "../../src/supervisor/client.mjs";

const authKey = Buffer.alloc(32, 0x73);

test("request accepts AbortSignal, rejects promptly with AbortError, and removes its timer and listener", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ah-client-abort-"));
  const socketPath = join(root, "supervisor.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const controller = new AbortController();
  const { signal } = controller;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const requestTimers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    if (delay === 10_000) requestTimers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    requestTimers.delete(timer);
    return originalClearTimeout(timer);
  };
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const timer of requestTimers) originalClearTimeout(timer);
  });
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  let abortListeners = 0;
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") abortListeners += 1;
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") abortListeners -= 1;
    return remove(type, listener, options);
  };

  const started = Date.now();
  const pending = request({ socketPath, authKey, method: "health", params: {}, timeout: 10_000, signal });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.ok(Date.now() - started < 250, "abort did not reject promptly");
  assert.equal(requestTimers.size, 0);
  assert.equal(abortListeners, 0);
  assert.equal(sockets.size, 0);
});
