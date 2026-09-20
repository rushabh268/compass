import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const schema = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

function migrateSchema(db) {
  const runColumns = db.prepare("PRAGMA table_info(runs)").all();
  const archiveColumns = db.prepare("PRAGMA table_info(run_archive)").all();
  const hasLastEventUnix = runColumns.some((column) => column.name === "last_event_unix");
  const hasActivityHMAC = runColumns.some((column) => column.name === "activity_hmac");
  const hasArchiveLastEventUnix = archiveColumns.some((column) => column.name === "last_event_unix");
  const hasArchiveActivityHMAC = archiveColumns.some((column) => column.name === "activity_hmac");
  if (hasLastEventUnix && hasActivityHMAC && hasArchiveLastEventUnix && hasArchiveActivityHMAC) {
    // Fast path: no schema change and no legacy zero rows to heal, so skip
    // taking a write lock entirely (a plain read is safe alongside a WAL
    // writer and avoids adding lock contention to every ledger open).
    const legacyRuns = db.prepare("SELECT COUNT(*) AS count FROM runs WHERE last_event_unix = 0").get();
    const legacyArchives = db.prepare("SELECT COUNT(*) AS count FROM run_archive WHERE last_event_unix = 0").get();
    if (legacyRuns.count === 0 && legacyArchives.count === 0) return;
  }
  const migratedAtUnix = Math.floor(Date.now() / 1000);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!hasLastEventUnix) {
      db.exec("ALTER TABLE runs ADD COLUMN last_event_unix INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasActivityHMAC) db.exec("ALTER TABLE runs ADD COLUMN activity_hmac TEXT DEFAULT ''");
    if (!hasArchiveLastEventUnix) {
      db.exec("ALTER TABLE run_archive ADD COLUMN last_event_unix INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasArchiveActivityHMAC) db.exec("ALTER TABLE run_archive ADD COLUMN activity_hmac TEXT DEFAULT ''");
    // Legacy rows (pre-migration schema, or otherwise unset) carry last_event_unix=0,
    // which would make them look infinitely old and immediately prunable. Backfill
    // them to the migration's current time so retention windows start counting now.
    db.prepare("UPDATE runs SET last_event_unix = ? WHERE last_event_unix = 0").run(migratedAtUnix);
    db.prepare("UPDATE run_archive SET last_event_unix = ? WHERE last_event_unix = 0").run(migratedAtUnix);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readTransaction(db, operation) {
  db.exec("BEGIN DEFERRED");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(path) {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path must be a nonempty string");
  let databasePath = resolve(path);
  if (process.platform === "darwin" && (databasePath === "/var" || databasePath.startsWith("/var/"))) {
    databasePath = join(realpathSync("/var"), databasePath.slice(5));
  }
  const parent = dirname(databasePath);
  const root = parse(parent).root;
  const components = parent.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) throw new Error(`database path contains symlink: ${current}`);
      if (!entry.isDirectory()) throw new Error(`database parent component is not a directory: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      chmodSync(current, 0o700);
    }
  }

  const parentStat = lstatSync(parent);
  try {
    if (lstatSync(databasePath).isSymbolicLink()) throw new Error("database path must not be a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporaryRoot = realpathSync(tmpdir());
  if (dirname(parent) === temporaryRoot && parentStat.uid === process.getuid()) {
    chmodSync(parent, 0o700);
  }
  const securedParentStat = lstatSync(parent);
  if (securedParentStat.uid !== process.getuid()) throw new Error("database parent must be owned by the current uid");
  if ((securedParentStat.mode & 0o777) !== 0o700) throw new Error("database parent mode must be 0700");

  const db = new DatabaseSync(databasePath);
  try {
    chmodSync(databasePath, 0o600);
    db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    db.exec(schema);
    migrateSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
