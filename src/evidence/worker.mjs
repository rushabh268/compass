import { parentPort, workerData } from "node:worker_threads";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { openReadDatabase, readTransaction } from "../state/database.mjs";
import { verifyRun, verifyArchiveRecord } from "../state/integrity.mjs";
import { identityHMAC } from "../identity.mjs";

const key = Buffer.from(workerData.key),
  cursorKey = randomBytes(32);
const MAX_EVENTS = 50000,
  MAX_BYTES = 32 * 1024 * 1024,
  MAX_CACHE = 8,
  TTL = workerData.snapshotTTL,
  JOB_MS = 4000;
const cache = new Map();
let cacheBytes = 0;
function state(value) {
  return { version: 1, state: value };
}
function purge() {
  for (const [id, item] of cache)
    if (item.expiresAt <= Date.now()) {
      cache.delete(id);
      cacheBytes -= item.bytes;
    }
}
function cursor(snapshot, position) {
  const body = Buffer.from(
    JSON.stringify({
      snapshotID: snapshot.snapshotID,
      platform: snapshot.platform,
      runID: snapshot.runID,
      subjectHMAC: snapshot.subjectHMAC,
      head: snapshot.head,
      count: snapshot.eventCount,
      position,
      expiresAt: snapshot.expiresAt,
    }),
  ).toString("base64url");
  return (
    body + "." + createHmac("sha256", cursorKey).update(body).digest("hex")
  );
}
function page(snapshot, position) {
  const events = [];
  let bytes = 0;
  while (
    position + events.length < snapshot.events.length &&
    events.length < 50
  ) {
    const event = snapshot.events[position + events.length],
      size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (bytes + size > 60 * 1024) break;
    events.push(event);
    bytes += size;
  }
  if (!events.length && position < snapshot.events.length)
    return state("resource_exhausted");
  const next = position + events.length;
  return {
    version: 1,
    state: "ready",
    snapshotID: snapshot.snapshotID,
    head: snapshot.head,
    eventCount: snapshot.eventCount,
    expiresAt: snapshot.expiresAt,
    summary: snapshot.summary,
    groundingState: snapshot.groundingState,
    relationship: snapshot.relationship,
    events,
    nextCursor: next < snapshot.events.length ? cursor(snapshot, next) : null,
  };
}
function continuation(value) {
  purge();
  try {
    if (typeof value !== "string" || value.length > 4096) return state("stale");
    const [body, mac, ...rest] = value.split(".");
    if (rest.length || !/^[0-9a-f]{64}$/.test(mac ?? "")) return state("stale");
    const expected = createHmac("sha256", cursorKey).update(body).digest();
    if (!timingSafeEqual(Buffer.from(mac, "hex"), expected))
      return state("stale");
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
      snapshot = cache.get(parsed.snapshotID);
    if (
      !snapshot ||
      !Number.isSafeInteger(parsed.position) ||
      parsed.position < 0 ||
      parsed.position >= snapshot.eventCount ||
      cursor(snapshot, parsed.position) !== value
    )
      return state("stale");
    return page(snapshot, parsed.position);
  } catch {
    return state("stale");
  }
}
function begin(identity) {
  purge();
  let db;
  const started = Date.now();
  let totalBytes = 0,
    totalEvents = 0;
  const budget = () => {
    if (
      Date.now() - started > JOB_MS ||
      totalBytes > MAX_BYTES ||
      totalEvents > MAX_EVENTS
    )
      throw new RangeError("evidence budget");
  };
  try {
    db = openReadDatabase(workerData.path);
    const result = readTransaction(db, () => {
      const heads = [];
      function readRun(runID) {
        budget();
        const run = db.prepare("SELECT * FROM runs WHERE run_id=?").get(runID);
        const archive = db
          .prepare("SELECT * FROM run_archive WHERE run_id=?")
          .get(runID);
        if (run && archive) throw new Error("conflicting run");
        if (archive) {
          if (!verifyArchiveRecord(key, archive)) throw new Error("integrity");
          heads.push(archive.archive_hmac);
          return { state: "pruned", events: [] };
        }
        if (!run) {
          if (
            db.prepare("SELECT 1 FROM events WHERE run_id=? LIMIT 1").get(runID)
          )
            throw new Error("orphan events");
          return { state: "absent", events: [] };
        }
        if (run.event_count > MAX_EVENTS - totalEvents)
          throw new RangeError("evidence budget");
        const rows = [];
        for (const row of db
          .prepare(
            "SELECT run_id,dedupe_key,body,previous_hmac,hmac FROM events WHERE run_id=? ORDER BY id",
          )
          .iterate(runID)) {
          totalBytes += Buffer.byteLength(row.body) + 256;
          totalEvents++;
          budget();
          rows.push(row);
        }
        if (!verifyRun(key, run, runID, rows)) throw new Error("integrity");
        heads.push(run.commitment_hmac);
        const events = rows.map((row) => JSON.parse(row.body));
        if (events.some((event) => event.platform !== identity.platform))
          throw new Error("platform mismatch");
        return { state: "ready", events };
      }
      const root = readRun(identity.runID);
      const selected = root.events.filter(
        (event) =>
          event.sessionHMAC === identity.subjectHMAC &&
          (identity.kind !== "agent" ||
            event.parentSessionHMAC === identity.rootHMAC),
      );
      // A target hash alone cannot prove which parent owns an agent.
      if (identity.kind === "agent" && !selected.length)
        return state("unavailable");
      const relationship =
        identity.kind === "root"
          ? "self"
          : identity.kind === "agent"
            ? "direct"
            : selected.some(
                  (event) => event.parentSessionHMAC === identity.rootHMAC,
                )
              ? "direct"
              : "unknown";
      let groundingState = "available";
      const cutoff = new Date(Date.now() - 180 * 86400000);
      cutoff.setUTCDate(1);
      cutoff.setUTCHours(0, 0, 0, 0);
      const month = new Date();
      month.setUTCDate(1);
      month.setUTCHours(0, 0, 0, 0);
      while (month >= cutoff) {
        const run = readRun(
          identityHMAC(
            key,
            `${identity.platform}.run`,
            `grounding:${month.toISOString().slice(0, 7)}`,
          ),
        );
        if (run.state === "pruned") groundingState = "unavailable";
        selected.push(
          ...run.events.filter(
            (event) =>
              event.eventType === "GroundingInjection" &&
              event.sessionHMAC === identity.subjectHMAC,
          ),
        );
        month.setUTCMonth(month.getUTCMonth() - 1);
      }
      if (!selected.length)
        return {
          ...state(root.state === "pruned" ? "pruned" : "absent"),
          groundingState,
        };
      return {
        events: selected,
        relationship,
        head: createHash("sha256").update(JSON.stringify(heads)).digest("hex"),
        groundingState,
      };
    });
    // Transaction is released before caching or delivering any UI page.
    if (result.state) return result;
    budget();
    const bytes = Buffer.byteLength(JSON.stringify(result.events));
    if (bytes > MAX_BYTES) return state("resource_exhausted");
    while (cache.size >= MAX_CACHE || cacheBytes + bytes > MAX_BYTES) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).bytes;
      cache.delete(oldest);
    }
    const snapshot = {
      ...identity,
      ...result,
      snapshotID: randomUUID(),
      expiresAt: Date.now() + TTL,
      eventCount: result.events.length,
      bytes,
      summary: {
        events: result.events.filter(
          (e) => e.eventType !== "GroundingInjection",
        ).length,
        grounding: result.events.filter(
          (e) => e.eventType === "GroundingInjection",
        ).length,
      },
    };
    cache.set(snapshot.snapshotID, snapshot);
    cacheBytes += bytes;
    return page(snapshot, 0);
  } catch (error) {
    return state(
      error instanceof RangeError ? "resource_exhausted" : "unavailable",
    );
  } finally {
    db?.close();
  }
}
// Reader retention never invokes the supervisor's full-ledger synchronous scan.
function retentionStatus() {
  let db;
  try {
    db = openReadDatabase(workerData.path);
    return readTransaction(db, () => {
      const started = Date.now();
      let events = 0,
        bytes = 0,
        runs = 0,
        decisions = 0,
        archives = 0,
        archivedBytes = 0,
        archiveValid = 0,
        archiveInvalid = 0;
      const budget = () => {
        if (
          Date.now() - started > JOB_MS ||
          events > MAX_EVENTS ||
          bytes > MAX_BYTES ||
          runs + archives > MAX_EVENTS
        )
          throw new RangeError("evidence budget");
      };
      for (const run of db.prepare("SELECT * FROM runs").iterate()) {
        runs++;
        budget();
        const rows = [];
        for (const row of db
          .prepare(
            "SELECT run_id,dedupe_key,body,previous_hmac,hmac FROM events WHERE run_id=? ORDER BY id",
          )
          .iterate(run.run_id)) {
          events++;
          bytes += Buffer.byteLength(row.body);
          budget();
          rows.push(row);
        }
        if (!verifyRun(key, run, run.run_id, rows))
          throw new Error("integrity");
        if (rows.some((row) => JSON.parse(row.body).decision !== undefined))
          decisions++;
      }
      for (const archive of db.prepare("SELECT * FROM run_archive").iterate()) {
        archives++;
        archivedBytes += Buffer.byteLength(JSON.stringify(archive));
        budget();
        if (verifyArchiveRecord(key, archive)) archiveValid++;
        else archiveInvalid++;
      }
      return {
        activeRuns: runs,
        activeEvents: events,
        activeBytes: bytes,
        archivedRuns: archives,
        archivedBytes,
        archiveValid,
        archiveInvalid,
        policies: {
          metadata: { retentionDays: 180, runs: runs - decisions },
          decision: { retentionDays: 365, runs: decisions },
        },
      };
    });
  } catch (error) {
    return state(
      error instanceof RangeError ? "resource_exhausted" : "unavailable",
    );
  } finally {
    db?.close();
  }
}
parentPort.on("message", ({ id, method, params }) => {
  const result =
    method === "begin"
      ? begin(params)
      : method === "retention"
        ? retentionStatus()
        : continuation(params.cursor);
  parentPort.postMessage({ id, result });
});
