import { randomUUID } from "node:crypto";
import net from "node:net";

import { createRequest, encodeFrame, FrameDecoder, parseResponse } from "../protocol/rpc.mjs";

export function request({ socketPath, authKey, method, params, timeout = 5_000, id = randomUUID(), signal } = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) return Promise.reject(new TypeError("socketPath is required"));
  if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new TypeError("timeout must be positive"));
  const abortError = () => signal?.reason?.name === "AbortError"
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
  if (signal?.aborted) return Promise.reject(abortError());
  let outbound;
  try {
    outbound = encodeFrame(createRequest({ id, method, params, authKey }));
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const decoder = new FrameDecoder();
    const socket = net.createConnection(socketPath);
    let settled = false;
    let timer;
    const onAbort = () => finish(abortError());
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      error ? reject(error) : resolve(result);
    };
    timer = setTimeout(() => finish(new Error("request timed out")), timeout);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.once("connect", () => socket.write(outbound));
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(chunk)) {
          const response = parseResponse(value);
          if (response.id !== id) throw new Error("response id mismatch");
          if (response.error) finish(new Error(response.error.message));
          else finish(null, response.result);
          return;
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.once("end", () => {
      try { decoder.end(); } catch (error) { finish(error); return; }
      finish(new Error("connection closed without a response"));
    });
  });
}
