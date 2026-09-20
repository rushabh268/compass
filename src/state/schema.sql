CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  head_hmac TEXT NOT NULL,
  commitment_hmac TEXT NOT NULL,
  commitment TEXT NOT NULL,
  last_event_unix INTEGER NOT NULL DEFAULT 0,
  activity_hmac TEXT DEFAULT ''
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  dedupe_key TEXT NOT NULL,
  body TEXT NOT NULL,
  previous_hmac TEXT NOT NULL,
  hmac TEXT NOT NULL,
  UNIQUE (run_id, dedupe_key)
) STRICT;

CREATE TABLE IF NOT EXISTS run_archive (
  run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  head_hmac TEXT NOT NULL,
  commitment TEXT NOT NULL,
  pruned_at INTEGER NOT NULL,
  last_event_unix INTEGER NOT NULL DEFAULT 0,
  activity_hmac TEXT DEFAULT '',
  archive_hmac TEXT NOT NULL
) STRICT;
