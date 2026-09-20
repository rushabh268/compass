import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalLabels, createEvent } from "../protocol/event.mjs";
import { openDatabase, readTransaction } from "./database.mjs";
import { assertTransition } from "./state-machine.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertRunID(runID) {
  if (typeof runID !== "string" || runID.trim().length === 0 || [...runID].length > 1024) {
    throw new TypeError("runID must be a nonempty string of at most 1024 characters");
  }
}

function digest(key, previousHMAC, runID, dedupeKey, body) {
  return framedDigest(key, [previousHMAC, runID, dedupeKey, body]);
}

function commitmentDigest(key, runID, state, eventCount, headHMAC) {
  return framedDigest(key, ["run", runID, state, String(eventCount), headHMAC]);
}

function activityDigest(key, runID, lastEventUnix) {
  return framedDigest(key, ["activity", runID, String(lastEventUnix)]);
}

function archiveDigest(key, runID, state, eventCount, headHMAC, commitment, prunedAt, activityHMAC) {
  return framedDigest(key, ["archive", runID, state, String(eventCount), headHMAC, commitment, String(prunedAt), activityHMAC]);
}

function framedDigest(key, values) {
  const hmac = createHmac("sha256", key);
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length).update(bytes);
  }
  return hmac.digest("hex");
}

function matchesDigest(actual, expected) {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function serverUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function assertUnixSeconds(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative safe integer`);
}

function assertRetentionDays(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}

function hasDecision(rows) {
  for (const row of rows) {
    try {
      if (JSON.parse(row.body).decision !== undefined) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function receipt(row, inserted, event = JSON.parse(row.body)) {
  return freeze({
    event,
    previousHMAC: row.previous_hmac,
    hmac: row.hmac,
    inserted,
  });
}

export function openLedger({ path, hmacKey } = {}) {
  if (!(Buffer.isBuffer(hmacKey) || hmacKey instanceof Uint8Array) || hmacKey.byteLength < 32) {
    throw new TypeError("hmacKey must be a Buffer or Uint8Array of at least 32 bytes");
  }
  const key = Buffer.from(hmacKey);
  let db;
  let insertRun;
  let selectRun;
  let updateRun;
  let updateRunIntegrity;
  let selectDuplicate;
  let selectRunHead;
  let insertEvent;
  let selectEvents;
  let iterateEvents;
  let countRuns;
  let countEvents;
  let selectStateCounts;
  let selectMetrics;
  let selectNewestMetricTimestamp;
  let iterateRuns;
  let touchRun;
  let iterateInactiveRuns;
  let insertArchive;
  let deleteEvents;
  let deleteRun;
  let selectArchive;
  let iterateArchives;
  let backfillRunActivity;
  let backfillArchiveActivity;
  const migrationInvalidRuns = new Set();
  try {
    db = openDatabase(path);
    insertRun = db.prepare("INSERT INTO runs (run_id, state, event_count, head_hmac, commitment_hmac, commitment, last_event_unix, activity_hmac) VALUES (?, 'CREATED', 0, '', ?, ?, ?, ?)");
    selectRun = db.prepare("SELECT state, event_count, head_hmac, commitment_hmac, commitment, last_event_unix, activity_hmac FROM runs WHERE run_id = ?");
    updateRun = db.prepare("UPDATE runs SET state = ?, commitment_hmac = ?, commitment = ? WHERE run_id = ?");
    updateRunIntegrity = db.prepare("UPDATE runs SET event_count = ?, head_hmac = ?, commitment_hmac = ?, commitment = ? WHERE run_id = ?");
    touchRun = db.prepare("UPDATE runs SET last_event_unix = ?, activity_hmac = ? WHERE run_id = ?");
    selectDuplicate = db.prepare("SELECT run_id, dedupe_key, body, previous_hmac, hmac FROM events WHERE run_id = ? AND dedupe_key = ?");
    selectRunHead = db.prepare("SELECT run_id, dedupe_key, body, previous_hmac, hmac FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1");
    insertEvent = db.prepare("INSERT INTO events (run_id, dedupe_key, body, previous_hmac, hmac) VALUES (?, ?, ?, ?, ?)");
    selectEvents = db.prepare("SELECT run_id, dedupe_key, body, previous_hmac, hmac FROM events WHERE run_id = ? ORDER BY id");
    iterateEvents = db.prepare("SELECT run_id, dedupe_key, body, previous_hmac, hmac FROM events WHERE run_id = ? ORDER BY id");
    countRuns = db.prepare("SELECT COUNT(*) AS count FROM runs");
    countEvents = db.prepare("SELECT COUNT(*) AS count FROM events");
    selectStateCounts = db.prepare("SELECT state, COUNT(*) AS count FROM runs GROUP BY state");
    selectMetrics = db.prepare(`
      WITH bounded_events AS (
        SELECT body FROM events ORDER BY id DESC LIMIT ?
      )
      SELECT
        json_extract(body, '$.platform') AS platform,
        json_extract(body, '$.eventType') AS event_type,
        json_extract(body, '$.metadata.matchReason') AS match_reason,
        COUNT(*) AS count,
        SUM(CASE WHEN json_extract(body, '$.decision.action') = 'observe' THEN 1 ELSE 0 END) AS observe_decisions
      FROM bounded_events
      GROUP BY platform, event_type, match_reason
    `);
    selectNewestMetricTimestamp = db.prepare(`
      SELECT json_extract(body, '$.timestamp') AS timestamp
      FROM (SELECT id, body FROM events ORDER BY id DESC LIMIT ?)
      ORDER BY id DESC LIMIT 1
    `);
    iterateRuns = db.prepare("SELECT run_id, state, event_count, head_hmac, commitment_hmac, commitment, last_event_unix, activity_hmac FROM runs ORDER BY run_id");
    iterateInactiveRuns = db.prepare("SELECT run_id, state, event_count, head_hmac, commitment_hmac, commitment, last_event_unix, activity_hmac FROM runs WHERE state <> 'ACTIVE' ORDER BY last_event_unix, run_id");
    insertArchive = db.prepare("INSERT INTO run_archive (run_id, state, event_count, head_hmac, commitment, pruned_at, last_event_unix, activity_hmac, archive_hmac) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    deleteEvents = db.prepare("DELETE FROM events WHERE run_id = ?");
    deleteRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
    selectArchive = db.prepare("SELECT run_id, state, event_count, head_hmac, commitment, pruned_at, last_event_unix, activity_hmac, archive_hmac FROM run_archive WHERE run_id = ?");
    iterateArchives = db.prepare("SELECT run_id, state, event_count, head_hmac, commitment, pruned_at, last_event_unix, activity_hmac, archive_hmac FROM run_archive");
    backfillRunActivity = db.prepare("UPDATE runs SET activity_hmac = ? WHERE run_id = ?");
    backfillArchiveActivity = db.prepare("UPDATE run_archive SET activity_hmac = ?, archive_hmac = ? WHERE run_id = ?");
    migrateActivityHMAC();
  } catch (error) {
    try {
      db?.close();
    } finally {
      key.fill(0);
    }
    throw error;
  }

  function transaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function verifyRunIntegrity(run, runID, rows) {
    const expectedCommitment = commitmentDigest(key, runID, run.state, run.event_count, run.head_hmac);
    if (!Number.isSafeInteger(run.event_count) || run.event_count < 0 ||
        !matchesDigest(run.commitment_hmac, expectedCommitment) ||
        !matchesDigest(run.commitment, expectedCommitment)) return false;

    let previousHMAC = "";
    for (const row of rows) {
      let event;
      try {
        event = JSON.parse(row.body);
      } catch {
        return false;
      }
      if (event.runID !== row.run_id || event.dedupeKey !== row.dedupe_key) return false;
      const expected = digest(key, previousHMAC, row.run_id, row.dedupe_key, row.body);
      if (row.previous_hmac !== previousHMAC || !matchesDigest(row.hmac, expected)) return false;
      previousHMAC = row.hmac;
    }
    return rows.length === run.event_count && previousHMAC === run.head_hmac;
  }

  function verifyActivity(run, runID) {
    return Number.isSafeInteger(run.last_event_unix) && run.last_event_unix >= 0 &&
      matchesDigest(run.activity_hmac, activityDigest(key, runID, run.last_event_unix));
  }

  function verifyRun(run, runID, rows) {
    return verifyActivity(run, runID) && verifyRunIntegrity(run, runID, rows);
  }

  function verifyRunHeadIntegrity(run, runID) {
    const expectedCommitment = commitmentDigest(key, runID, run.state, run.event_count, run.head_hmac);
    if (!Number.isSafeInteger(run.event_count) || run.event_count < 0 ||
        !matchesDigest(run.commitment_hmac, expectedCommitment) ||
        !matchesDigest(run.commitment, expectedCommitment)) return false;

    const head = selectRunHead.get(runID);
    if (run.event_count === 0) return run.head_hmac === "" && head === undefined;
    if (!head || head.hmac !== run.head_hmac) return false;

    let event;
    try {
      event = JSON.parse(head.body);
    } catch {
      return false;
    }
    const expected = digest(key, head.previous_hmac, head.run_id, head.dedupe_key, head.body);
    return event.runID === head.run_id && event.dedupeKey === head.dedupe_key &&
      matchesDigest(head.hmac, expected);
  }

  function verifyRunHead(run, runID) {
    return verifyActivity(run, runID) && verifyRunHeadIntegrity(run, runID);
  }

  function integrityError(runID) {
    return new Error(`ledger integrity check failed for run: ${runID}`);
  }

  function assertNotArchived(runID) {
    if (selectArchive.get(runID)) {
      throw new Error(`cannot recreate archived run: ${runID}`);
    }
  }

  function retentionPolicy(rows, metadataDays, decisionDays) {
    const decision = hasDecision(rows);
    return { type: decision ? "decision" : "metadata", retentionDays: decision ? decisionDays : metadataDays };
  }

  function verifyArchiveRecord(archive) {
    if (!archive || !Number.isSafeInteger(archive.event_count) || archive.event_count < 0 ||
        !Number.isSafeInteger(archive.pruned_at) || archive.pruned_at < 0 ||
        !Number.isSafeInteger(archive.last_event_unix) || archive.last_event_unix < 0) return false;
    const commitment = commitmentDigest(key, archive.run_id, archive.state, archive.event_count, archive.head_hmac);
    const expected = archiveDigest(
      key,
      archive.run_id,
      archive.state,
      archive.event_count,
      archive.head_hmac,
      archive.commitment,
      archive.pruned_at,
      archive.activity_hmac,
    );
    return matchesDigest(archive.activity_hmac, activityDigest(key, archive.run_id, archive.last_event_unix)) &&
      matchesDigest(archive.commitment, commitment) && matchesDigest(archive.archive_hmac, expected);
  }

  function verifyLegacyArchiveRecord(archive) {
    if (!archive || !Number.isSafeInteger(archive.event_count) || archive.event_count < 0 ||
        !Number.isSafeInteger(archive.pruned_at) || archive.pruned_at < 0) return false;
    const commitment = commitmentDigest(key, archive.run_id, archive.state, archive.event_count, archive.head_hmac);
    const expected = framedDigest(key, [
      "archive",
      archive.run_id,
      archive.state,
      String(archive.event_count),
      archive.head_hmac,
      archive.commitment,
      String(archive.pruned_at),
    ]);
    return matchesDigest(archive.commitment, commitment) && matchesDigest(archive.archive_hmac, expected);
  }

  function migrateActivityHMAC() {
    const legacy = db.prepare("SELECT EXISTS(SELECT 1 FROM runs WHERE activity_hmac = '' UNION ALL SELECT 1 FROM run_archive WHERE activity_hmac = '') AS legacy").get();
    if (!legacy.legacy) return;
    transaction(() => {
      for (const run of iterateRuns.iterate()) {
        if (run.activity_hmac !== "") continue;
        if (!verifyRunIntegrity(run, run.run_id, selectEvents.all(run.run_id))) {
          migrationInvalidRuns.add(run.run_id);
          continue;
        }
        backfillRunActivity.run(activityDigest(key, run.run_id, run.last_event_unix), run.run_id);
      }
      for (const archive of iterateArchives.iterate()) {
        if (archive.activity_hmac !== "") continue;
        if (!verifyLegacyArchiveRecord(archive)) {
          continue;
        }
        const activityHMAC = activityDigest(key, archive.run_id, archive.last_event_unix);
        backfillArchiveActivity.run(
          activityHMAC,
          archiveDigest(
            key,
            archive.run_id,
            archive.state,
            archive.event_count,
            archive.head_hmac,
            archive.commitment,
            archive.pruned_at,
            activityHMAC,
          ),
          archive.run_id,
        );
      }
    });
  }

  let closed = false;

  return Object.freeze({
    createRun(runID) {
      assertRunID(runID);
      return transaction(() => {
        assertNotArchived(runID);
        const commitment = commitmentDigest(key, runID, "CREATED", 0, "");
        const lastEventUnix = serverUnixSeconds();
        insertRun.run(runID, commitment, commitment, lastEventUnix, activityDigest(key, runID, lastEventUnix));
        return freeze({ runID, state: "CREATED" });
      });
    },

    ensureRun(runID) {
      assertRunID(runID);
      return transaction(() => {
        let run = selectRun.get(runID);
        if (run) {
          if (!verifyRunHead(run, runID)) throw integrityError(runID);
          const lastEventUnix = Math.max(run.last_event_unix, serverUnixSeconds());
          touchRun.run(lastEventUnix, activityDigest(key, runID, lastEventUnix), runID);
          return freeze({ runID, state: run.state, created: false });
        }
        // Reject IDs already present in run_archive: recreating them would poison
        // the archive's run_id primary key and let a pruned chain be replayed.
        assertNotArchived(runID);
        const commitment = commitmentDigest(key, runID, "CREATED", 0, "");
        const lastEventUnix = serverUnixSeconds();
        insertRun.run(runID, commitment, commitment, lastEventUnix, activityDigest(key, runID, lastEventUnix));
        run = selectRun.get(runID);
        if (!verifyRunHead(run, runID)) throw integrityError(runID);
        return freeze({ runID, state: "CREATED", created: true });
      });
    },

    transitionRun(runID, nextState) {
      assertRunID(runID);
      return transaction(() => {
        const run = selectRun.get(runID);
        if (!run) throw new Error(`unknown run: ${runID}`);
        if (!verifyRun(run, runID, selectEvents.all(runID))) throw integrityError(runID);
        assertTransition(run.state, nextState);
        const commitment = commitmentDigest(key, runID, nextState, run.event_count, run.head_hmac);
        updateRun.run(nextState, commitment, commitment, runID);
        return freeze({ runID, state: nextState });
      });
    },

    append(input) {
      const event = createEvent(input);
      const body = JSON.stringify(event);
      return transaction(() => {
        const run = selectRun.get(event.runID);
        if (!run) throw new Error(`unknown run: ${event.runID}`);
        if (!verifyRunHead(run, event.runID)) throw integrityError(event.runID);
        const duplicate = selectDuplicate.get(event.runID, event.dedupeKey);
        if (duplicate) {
          let persistedEvent;
          try {
            persistedEvent = JSON.parse(duplicate.body);
          } catch {
            throw integrityError(event.runID);
          }
          const expected = digest(key, duplicate.previous_hmac, duplicate.run_id, duplicate.dedupe_key, duplicate.body);
          if (persistedEvent.runID !== duplicate.run_id || persistedEvent.dedupeKey !== duplicate.dedupe_key ||
              !matchesDigest(duplicate.hmac, expected)) throw integrityError(event.runID);
          if (duplicate.body !== body) throw new Error("dedupe key conflict");
          const lastEventUnix = Math.max(run.last_event_unix, serverUnixSeconds());
          touchRun.run(lastEventUnix, activityDigest(key, event.runID, lastEventUnix), event.runID);
          return receipt(duplicate, false, persistedEvent);
        }
        const previousHMAC = run.head_hmac;
        const hmac = digest(key, previousHMAC, event.runID, event.dedupeKey, body);
        insertEvent.run(event.runID, event.dedupeKey, body, previousHMAC, hmac);
        const eventCount = run.event_count + 1;
        const commitment = commitmentDigest(key, event.runID, run.state, eventCount, hmac);
        updateRunIntegrity.run(eventCount, hmac, commitment, commitment, event.runID);
        const lastEventUnix = Math.max(run.last_event_unix, serverUnixSeconds());
        touchRun.run(lastEventUnix, activityDigest(key, event.runID, lastEventUnix), event.runID);
        return receipt({ body, previous_hmac: previousHMAC, hmac }, true);
      });
    },

    listEvents(runID) {
      assertRunID(runID);
      return readTransaction(db, () => {
        const run = selectRun.get(runID);
        if (!run) throw new Error(`unknown run: ${runID}`);
        const rows = selectEvents.all(runID);
        if (!verifyRun(run, runID, rows)) throw integrityError(runID);
        return freeze(rows.map((row) => JSON.parse(row.body)));
      });
    },

    listEventsPage(runID, { cursor = 0, limit = 100, maxBytes = 786_432 } = {}) {
      assertRunID(runID);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("cursor must be a nonnegative integer");
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
      return readTransaction(db, () => {
        const run = selectRun.get(runID);
        if (!run) throw new Error(`unknown run: ${runID}`);
        const expectedCommitment = commitmentDigest(key, runID, run.state, run.event_count, run.head_hmac);
        if (!verifyActivity(run, runID) || !Number.isSafeInteger(run.event_count) || run.event_count < 0 ||
            !matchesDigest(run.commitment_hmac, expectedCommitment) ||
            !matchesDigest(run.commitment, expectedCommitment)) throw integrityError(runID);

        const events = [];
        let pageFull = false;
        let previousHMAC = "";
        let count = 0;
        for (const row of iterateEvents.iterate(runID)) {
          let event;
          try {
            event = JSON.parse(row.body);
          } catch {
            throw integrityError(runID);
          }
          if (event.runID !== row.run_id || event.dedupeKey !== row.dedupe_key) throw integrityError(runID);
          const expected = digest(key, previousHMAC, row.run_id, row.dedupe_key, row.body);
          if (row.previous_hmac !== previousHMAC || !matchesDigest(row.hmac, expected)) throw integrityError(runID);
          previousHMAC = row.hmac;

          if (!pageFull && count >= cursor && events.length < limit) {
            const candidate = { events: [...events, event], nextCursor: count + 1 < run.event_count ? count + 1 : null };
            if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) events.push(event);
            else pageFull = true;
          }
          count += 1;
        }
        if (count !== run.event_count || previousHMAC !== run.head_hmac) throw integrityError(runID);
        if (cursor < count && events.length === 0) throw new RangeError("event exceeds page budget");
        const next = cursor + events.length;
        return freeze({ events, nextCursor: next < count ? next : null });
      });
    },

    verifyChain(runID) {
      assertRunID(runID);
      return readTransaction(db, () => {
        const run = selectRun.get(runID);
        if (!run) throw new Error(`unknown run: ${runID}`);
        if (migrationInvalidRuns.has(runID)) throw integrityError(runID);
        return verifyRun(run, runID, selectEvents.all(runID));
      });
    },

    status() {
      return readTransaction(db, () => {
        const states = {};
        for (const row of selectStateCounts.all()) states[row.state] = row.count;
        return freeze({
          runs: countRuns.get().count,
          events: countEvents.get().count,
          states,
        });
      });
    },

    metrics({ window = 10_000 } = {}) {
      if (!Number.isSafeInteger(window) || window < 1 || window > 10_000) {
        throw new TypeError("window must be a safe integer from 1 through 10000");
      }
      return readTransaction(db, () => {
        const platforms = {};
        const eventTypes = {};
        const matchReasons = {};
        let eventCount = 0;
        let injections = 0;
        let harnessMetrics = 0;
        let observeDecisions = 0;
        for (const row of selectMetrics.all(window)) {
          eventCount += row.count;
          platforms[row.platform] = (platforms[row.platform] ?? 0) + row.count;
          const eventType = canonicalLabels.has(row.event_type) ? row.event_type : "other";
          eventTypes[eventType] = (eventTypes[eventType] ?? 0) + row.count;
          if (row.event_type === "GroundingInjection") {
            injections += row.count;
            if (["ticket", "branch-folder-overlap", "none"].includes(row.match_reason)) {
              matchReasons[row.match_reason] = (matchReasons[row.match_reason] ?? 0) + row.count;
            }
          }
          if (row.event_type === "HarnessMetrics") harnessMetrics += row.count;
          observeDecisions += row.observe_decisions;
        }
        return freeze({
          window: { maxEvents: window, eventCount },
          newestEventTimestamp: selectNewestMetricTimestamp.get(window)?.timestamp ?? null,
          platforms,
          eventTypes,
          grounding: { injections, matchReasons },
          coalescing: { harnessMetrics },
          dlp: { observeDecisions },
        });
      });
    },

    verifyAll() {
      return readTransaction(db, () => {
        let valid = 0;
        let invalid = 0;
        for (const run of iterateRuns.iterate()) {
          if (verifyRun(run, run.run_id, selectEvents.all(run.run_id))) valid += 1;
          else invalid += 1;
        }
        // Archived runs are folded into the same valid/invalid counts: a
        // tampered run_archive row must be verified against its own HMAC, not
        // trusted as-is, and must surface here as invalid rather than ignored.
        for (const archive of iterateArchives.iterate()) {
          if (verifyArchiveRecord(archive)) valid += 1;
          else invalid += 1;
        }
        return freeze({ valid, invalid });
      });
    },

    getRetentionPolicy(runID, { metadataDays = 180, decisionDays = 365 } = {}) {
      assertRunID(runID);
      assertRetentionDays(metadataDays, "metadataDays");
      assertRetentionDays(decisionDays, "decisionDays");
      return readTransaction(db, () => {
        const run = selectRun.get(runID);
        if (!run) throw new Error(`unknown run: ${runID}`);
        const rows = selectEvents.all(runID);
        if (!verifyRun(run, runID, rows)) throw integrityError(runID);
        return freeze(retentionPolicy(rows, metadataDays, decisionDays));
      });
    },

    pruneRuns({ olderThanUnix, nowUnix = serverUnixSeconds(), metadataDays = 180, decisionDays = 365, maxRuns = 100, dryRun = false } = {}) {
      if (olderThanUnix !== undefined) assertUnixSeconds(olderThanUnix, "olderThanUnix");
      assertUnixSeconds(nowUnix, "nowUnix");
      assertRetentionDays(metadataDays, "metadataDays");
      assertRetentionDays(decisionDays, "decisionDays");
      if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 1_000) {
        throw new TypeError("maxRuns must be a positive safe integer no greater than 1000");
      }
      if (typeof dryRun !== "boolean") throw new TypeError("dryRun must be a boolean");

      return transaction(() => {
        const eligibleRuns = [];
        // iterateInactiveRuns already excludes state = 'ACTIVE': ACTIVE runs are
        // never eligible for pruning regardless of age. Every remaining state
        // (CREATED, ADMITTED, SNAPSHOTTED, etc. — live adapters can idle in
        // CREATED, not just ADMITTED) must still clear the age cutoff below.
        for (const run of iterateInactiveRuns.iterate()) {
          if (!Number.isSafeInteger(run.last_event_unix) || run.last_event_unix < 0) throw integrityError(run.run_id);
          const rows = selectEvents.all(run.run_id);
          if (!verifyRun(run, run.run_id, rows)) throw integrityError(run.run_id);
          eligibleRuns.push({ run, rows });
        }

        const candidates = [];
        for (const { run, rows } of eligibleRuns) {
          const policy = retentionPolicy(rows, metadataDays, decisionDays);
          const policyCutoff = nowUnix - policy.retentionDays * 86_400;
          // An explicit olderThanUnix is an additional, stricter cutoff: it can
          // only narrow eligibility, never shorten the per-run 180/365-day
          // policy window. There is no "0 forces everything" bypass — 0 is a
          // literal cutoff like any other.
          const cutoff = olderThanUnix === undefined ? policyCutoff : Math.min(olderThanUnix, policyCutoff);
          if (run.last_event_unix > cutoff) continue;
          candidates.push({ run, policy });
          if (candidates.length === maxRuns) break;
        }

        const archived = candidates.map(({ run }) => run.run_id);
        if (!dryRun) {
          for (const { run } of candidates) {
            const archiveHMAC = archiveDigest(
              key,
              run.run_id,
              run.state,
              run.event_count,
              run.head_hmac,
              run.commitment,
              nowUnix,
              run.activity_hmac,
            );
            insertArchive.run(
              run.run_id,
              run.state,
              run.event_count,
              run.head_hmac,
              run.commitment,
              nowUnix,
              run.last_event_unix,
              run.activity_hmac,
              archiveHMAC,
            );
            deleteEvents.run(run.run_id);
            if (deleteRun.run(run.run_id).changes !== 1) throw integrityError(run.run_id);
          }
        }
        return freeze({ archived, dryRun });
      });
    },

    verifyArchive(runID) {
      assertRunID(runID);
      return readTransaction(db, () => verifyArchiveRecord(selectArchive.get(runID)));
    },

    retentionStatus({ metadataDays = 180, decisionDays = 365 } = {}) {
      assertRetentionDays(metadataDays, "metadataDays");
      assertRetentionDays(decisionDays, "decisionDays");
      return readTransaction(db, () => {
        let activeBytes = 0;
        let decisionRuns = 0;
        let metadataRuns = 0;
        for (const run of iterateRuns.iterate()) {
          const rows = selectEvents.all(run.run_id);
          if (!verifyRun(run, run.run_id, rows)) throw integrityError(run.run_id);
          for (const row of rows) activeBytes += Buffer.byteLength(row.body);
          if (hasDecision(rows)) decisionRuns += 1;
          else metadataRuns += 1;
        }
        let archivedRuns = 0;
        let archivedBytes = 0;
        let archiveValid = 0;
        let archiveInvalid = 0;
        for (const archive of iterateArchives.iterate()) {
          archivedRuns += 1;
          archivedBytes += Buffer.byteLength(JSON.stringify(archive));
          // Verify each archive's HMAC rather than trusting the stored row, so
          // tampering is reported instead of silently counted as healthy.
          if (verifyArchiveRecord(archive)) archiveValid += 1;
          else archiveInvalid += 1;
        }
        return freeze({
          activeRuns: countRuns.get().count,
          activeEvents: countEvents.get().count,
          activeBytes,
          archivedRuns,
          archivedBytes,
          archiveValid,
          archiveInvalid,
          policies: {
            metadata: { retentionDays: metadataDays, runs: metadataRuns },
            decision: { retentionDays: decisionDays, runs: decisionRuns },
          },
        });
      });
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        key.fill(0);
      }
    },
  });
}
