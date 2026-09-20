import { lstat, unlink } from "node:fs/promises";
import net from "node:net";

import { authenticateRequest, createResponse, encodeFrame, FrameDecoder, parseRequest } from "../protocol/rpc.mjs";
import { prepareSocketPath, removeStaleSocket, setSocketMode } from "../paths.mjs";

const methodParams = new Map([
  ["health", []],
  ["ensureRun", ["runID"]],
  ["createRun", ["runID"]],
  ["transitionRun", ["runID", "nextState"]],
  ["append", ["event"]],
  ["listEvents", ["runID", "cursor", "limit"]],
  ["verifyChain", ["runID"]],
  ["status", []],
  ["verifyAll", []],
  ["retentionStatus", []],
  ["prune", ["olderThanUnix", "maxRuns", "dryRun"]],
  ["metrics", []],
]);
const MAX_PRUNE_RUNS = 1_000;
const DEFAULT_IDLE_TIMEOUT = 30_000;
const DEFAULT_MAX_CONNECTIONS = 128;
const MAX_READ_REPLAY_ENTRIES = 1_024;
const DEFAULT_MAX_MUTATION_REPLAY_ENTRIES = 4_096;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const LIST_PAGE_BYTES = 768 * 1024;
const CACHEABLE_ERROR_CODES = new Set(["INVALID_ARGUMENT", "NOT_FOUND"]);

function validParams(method, params) {
  const allowed = methodParams.get(method);
  if (!allowed) return false;
  const fields = Object.keys(params);
  if (method === "listEvents") {
    return Object.hasOwn(params, "runID") && fields.every((field) => allowed.includes(field)) &&
      (!Object.hasOwn(params, "cursor") || (Number.isSafeInteger(params.cursor) && params.cursor >= 0)) &&
      (!Object.hasOwn(params, "limit") || (Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= MAX_LIST_LIMIT));
  }
  if (method === "prune") {
    return fields.length === allowed.length && allowed.every((field) => Object.hasOwn(params, field)) &&
      typeof params.dryRun === "boolean" &&
      Number.isSafeInteger(params.maxRuns) && params.maxRuns >= 1 && params.maxRuns <= MAX_PRUNE_RUNS &&
      Number.isSafeInteger(params.olderThanUnix) && params.olderThanUnix >= 0;
  }
  return fields.length === allowed.length && allowed.every((field) => Object.hasOwn(params, field));
}

function write(socket, frame) {
  if (socket.destroyed || socket.write(frame)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("connection closed")); };
    const onError = (error) => { cleanup(); reject(error); };
    socket.once("drain", onDrain);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function dispatch(ledger, method, params, id, metrics) {
  switch (method) {
    case "health": return { ok: true };
    case "ensureRun": return ledger.ensureRun(params.runID);
    case "createRun": return ledger.createRun(params.runID);
    case "transitionRun": return ledger.transitionRun(params.runID, params.nextState);
    case "append": return ledger.append(params.event);
    case "listEvents": return typeof ledger.listEventsPage === "function"
      ? ledger.listEventsPage(params.runID, {
        cursor: params.cursor,
        limit: params.limit,
        maxBytes: LIST_PAGE_BYTES - 4 - Buffer.byteLength(JSON.stringify(createResponse({ id, result: {} }))) + 2,
      })
      : listEventsPage(null, ledger.listEvents(params.runID), params);
    case "verifyChain": return ledger.verifyChain(params.runID);
    case "status": return ledger.status();
    case "verifyAll": return ledger.verifyAll();
    case "retentionStatus": return ledger.retentionStatus();
    case "metrics": return metrics();
    case "prune": return ledger.pruneRuns(params);
    default: throw new Error("unknown method");
  }
}

function listEventsPage(id, events, { cursor = 0, limit = DEFAULT_LIST_LIMIT }) {
  if (!Array.isArray(events)) throw new TypeError("listEvents must return an array");
  const limited = events.slice(cursor, cursor + limit);
  const limitedPage = { events: limited, nextCursor: cursor + limited.length < events.length ? cursor + limited.length : null };
  try {
    encodeFrame(createResponse({ id: id ?? "list-events", result: limitedPage }));
    return limitedPage;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const page = [];
  const end = Math.min(events.length, cursor + limit);
  for (let index = cursor; index < end; index += 1) {
    const candidate = { events: [...page, events[index]], nextCursor: index + 1 < events.length ? index + 1 : null };
    if (encodeFrame(createResponse({ id: id ?? "list-events", result: candidate })).length > LIST_PAGE_BYTES) break;
    page.push(events[index]);
  }
  if (cursor < events.length && page.length === 0) throw new RangeError("event exceeds page budget");
  const next = cursor + page.length;
  return { events: page, nextCursor: next < events.length ? next : null };
}

export async function startSupervisor({ socketPath, authKey, ledger, idleTimeout = DEFAULT_IDLE_TIMEOUT, maxConnections = DEFAULT_MAX_CONNECTIONS, maxMutationReplayEntries = DEFAULT_MAX_MUTATION_REPLAY_ENTRIES, metricsCacheTTL = 10_000, now = Date.now } = {}) {
  if (!Buffer.isBuffer(authKey) || authKey.length < 32) throw new TypeError("authKey must be a Buffer of at least 32 bytes");
  if (ledger === null || typeof ledger !== "object") throw new TypeError("ledger is required");
  if (!Number.isFinite(idleTimeout) || idleTimeout <= 0) throw new TypeError("idleTimeout must be positive");
  if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) throw new TypeError("maxConnections must be a positive integer");
  if (!Number.isSafeInteger(maxMutationReplayEntries) || maxMutationReplayEntries <= 0) throw new TypeError("maxMutationReplayEntries must be a positive integer");
  if (!Number.isSafeInteger(metricsCacheTTL) || metricsCacheTTL <= 0) metricsCacheTTL = 10_000;
  if (typeof now !== "function") now = Date.now;
  const key = Buffer.from(authKey);
  const path = await prepareSocketPath(socketPath);
  await removeStaleSocket(path);

  const sockets = new Set();
  const readReplay = new Map();
  const mutationReplay = new Map();
  const idempotentReplay = new Map();
  const inFlight = new Map();
  const mutationMethods = new Set(["ensureRun", "createRun", "transitionRun", "append", "prune"]);
  const durableIdempotentMethods = new Set(["ensureRun", "append"]);
  let mutationsInFlight = 0;
  let cachedMetrics;
  let cachedMetricsExpiresAt = 0;

  function metrics() {
    if (cachedMetrics !== undefined && now() < cachedMetricsExpiresAt) return cachedMetrics;
    cachedMetrics = ledger.metrics({ window: 2_000 });
    cachedMetricsExpiresAt = now() + metricsCacheTTL;
    return cachedMetrics;
  }

  async function execute(request) {
    let response;
    if (!methodParams.has(request.method)) {
      response = createResponse({ id: request.id, error: { code: "NOT_FOUND", message: "unknown method" } });
    } else if (!validParams(request.method, request.params)) {
      response = createResponse({ id: request.id, error: { code: "INVALID_ARGUMENT", message: "invalid method parameters" } });
    } else {
      try {
        const result = await dispatch(ledger, request.method, request.params, request.id, metrics);
        response = createResponse({ id: request.id, result });
      } catch {
        response = createResponse({ id: request.id, error: { code: "FAILED", message: "request failed" } });
      }
    }
    try {
      encodeFrame(response);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      response = createResponse({ id: request.id, error: { code: "RESOURCE_EXHAUSTED", message: "response exceeds frame limit" } });
    }
    return response;
  }
  const server = net.createServer((socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(idleTimeout, () => socket.destroy());
    const decoder = new FrameDecoder();
    let pending = Promise.resolve();
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      if (messages.length > 0) socket.pause();
      for (const input of messages) {
        pending = pending.then(async () => {
          let id = "invalid-request";
          let response;
          try {
            const request = parseRequest(input);
            id = request.id;
            if (!authenticateRequest(request, key)) {
              response = createResponse({ id, error: { code: "UNAUTHENTICATED", message: "authentication failed" } });
            } else {
              const previous = mutationReplay.get(id) ?? idempotentReplay.get(id) ??
                (request.method === "metrics" ? undefined : readReplay.get(id));
              if (previous) {
                response = previous.auth === request.auth
                  ? previous.response
                  : createResponse({ id, error: { code: "INVALID_ARGUMENT", message: "request ID conflict" } });
              } else {
                const reserved = inFlight.get(id);
                if (reserved) {
                  response = reserved.auth === request.auth
                    ? await reserved.response
                    : createResponse({ id, error: { code: "INVALID_ARGUMENT", message: "request ID conflict" } });
                } else {
                  const dryRunPrune = request.method === "prune" && request.params.dryRun === true;
                  const mutation = mutationMethods.has(request.method) && !dryRunPrune;
                  const protectedMutation = mutation && !durableIdempotentMethods.has(request.method);
                  if (protectedMutation && mutationReplay.size + mutationsInFlight >= maxMutationReplayEntries) {
                    response = createResponse({ id, error: { code: "RESOURCE_EXHAUSTED", message: "mutation replay capacity exhausted" } });
                  } else {
                    const operation = execute(request);
                    if (protectedMutation) mutationsInFlight += 1;
                    inFlight.set(id, { auth: request.auth, response: operation });
                    try {
                      response = await operation;
                      const cache = protectedMutation ? mutationReplay : mutation ? idempotentReplay :
                        request.method === "metrics" ? undefined : readReplay;
                      if (cache && (!response.error || CACHEABLE_ERROR_CODES.has(response.error.code))) {
                        cache.set(id, { auth: request.auth, response });
                        const cacheLimit = mutation ? maxMutationReplayEntries : MAX_READ_REPLAY_ENTRIES;
                        if (!protectedMutation && cache.size > cacheLimit) cache.delete(cache.keys().next().value);
                      }
                    } finally {
                      inFlight.delete(id);
                      if (protectedMutation) mutationsInFlight -= 1;
                    }
                  }
                }
              }
            }
          } catch {
            response = createResponse({ id, error: { code: "FAILED", message: "request failed" } });
          }
          let frame;
          try {
            frame = encodeFrame(response);
          } catch (error) {
            if (!(error instanceof RangeError)) throw error;
            response = createResponse({ id, error: { code: "RESOURCE_EXHAUSTED", message: "response exceeds frame limit" } });
            frame = encodeFrame(response);
          }
          await write(socket, frame);
          socket.resume();
        }).catch(() => socket.destroy());
      }
    });
  });

  try {
    await new Promise((resolve, reject) => server.listen(path, resolve).once("error", reject));
    await setSocketMode(path);
    const owned = await lstat(path);
    let closed = false;
    return Object.freeze({
      get authKeyCleared() { return key.every((byte) => byte === 0); },
      async close() {
        if (closed) return;
        closed = true;
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        try {
          const current = await lstat(path);
          if (current.dev === owned.dev && current.ino === owned.ino) await unlink(path);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        } finally {
          key.fill(0);
        }
      },
    });
  } catch (error) {
    server.close();
    key.fill(0);
    throw error;
  }
}
