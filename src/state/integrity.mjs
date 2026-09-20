import { createHmac, timingSafeEqual } from "node:crypto";
export function digest(key, previousHMAC, runID, dedupeKey, body) {
  return framedDigest(key, [previousHMAC, runID, dedupeKey, body]);
}

export function commitmentDigest(key, runID, state, eventCount, headHMAC) {
  return framedDigest(key, ["run", runID, state, String(eventCount), headHMAC]);
}

export function activityDigest(key, runID, lastEventUnix) {
  return framedDigest(key, ["activity", runID, String(lastEventUnix)]);
}

export function archiveDigest(
  key,
  runID,
  state,
  eventCount,
  headHMAC,
  commitment,
  prunedAt,
  activityHMAC,
) {
  return framedDigest(key, [
    "archive",
    runID,
    state,
    String(eventCount),
    headHMAC,
    commitment,
    String(prunedAt),
    activityHMAC,
  ]);
}

export function framedDigest(key, values) {
  const hmac = createHmac("sha256", key);
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length).update(bytes);
  }
  return hmac.digest("hex");
}

export function matchesDigest(actual, expected) {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual))
    return false;
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

export function verifyRunIntegrity(key, run, runID, rows) {
  const expectedCommitment = commitmentDigest(
    key,
    runID,
    run.state,
    run.event_count,
    run.head_hmac,
  );
  if (
    !Number.isSafeInteger(run.event_count) ||
    run.event_count < 0 ||
    !matchesDigest(run.commitment_hmac, expectedCommitment) ||
    !matchesDigest(run.commitment, expectedCommitment)
  )
    return false;

  let previousHMAC = "";
  for (const row of rows) {
    let event;
    try {
      event = JSON.parse(row.body);
    } catch {
      return false;
    }
    if (event.runID !== row.run_id || event.dedupeKey !== row.dedupe_key)
      return false;
    const expected = digest(
      key,
      previousHMAC,
      row.run_id,
      row.dedupe_key,
      row.body,
    );
    if (
      row.previous_hmac !== previousHMAC ||
      !matchesDigest(row.hmac, expected)
    )
      return false;
    previousHMAC = row.hmac;
  }
  return rows.length === run.event_count && previousHMAC === run.head_hmac;
}

export function verifyActivity(key, run, runID) {
  return (
    Number.isSafeInteger(run.last_event_unix) &&
    run.last_event_unix >= 0 &&
    matchesDigest(
      run.activity_hmac,
      activityDigest(key, runID, run.last_event_unix),
    )
  );
}

export function verifyRun(key, run, runID, rows) {
  return (
    verifyActivity(key, run, runID) && verifyRunIntegrity(key, run, runID, rows)
  );
}

export function verifyArchiveRecord(key, archive) {
  if (
    !archive ||
    !Number.isSafeInteger(archive.event_count) ||
    archive.event_count < 0 ||
    !Number.isSafeInteger(archive.pruned_at) ||
    archive.pruned_at < 0 ||
    !Number.isSafeInteger(archive.last_event_unix) ||
    archive.last_event_unix < 0
  )
    return false;
  const commitment = commitmentDigest(
    key,
    archive.run_id,
    archive.state,
    archive.event_count,
    archive.head_hmac,
  );
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
  return (
    matchesDigest(
      archive.activity_hmac,
      activityDigest(key, archive.run_id, archive.last_event_unix),
    ) &&
    matchesDigest(archive.commitment, commitment) &&
    matchesDigest(archive.archive_hmac, expected)
  );
}
