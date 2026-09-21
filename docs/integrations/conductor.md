# Conductor reader integration v1

This optional local API never installs native hooks, changes native configuration,
launches a native coding client, or sends model requests. Conductor retains native
transcripts and usage. Compass returns authenticated metadata observations only.

RPC envelope and authentication remain version 1: a four-byte big-endian length,
then UTF-8 JSON (maximum 1 MiB). HMAC-SHA256 authenticates recursively key-sorted
JSON of `{version,id,method,params}`, excluding `auth`. Keys are raw bytes.
The writer/identity key must never be given to a companion.

Reader methods: health, status, metrics, retentionStatus, beginSessionEvidence,
continueSessionEvidence. Every other method, including dry-run prune and legacy
listEvents, returns PERMISSION_DENIED before any replay lookup. Authentication
failure returns UNAUTHENTICATED. Invalid selectors return INVALID_ARGUMENT.

`beginSessionEvidence` parameters:
```json
{"version":1,"platform":"claude","rootSessionID":"synthetic-root","subject":{"kind":"agent","nativeID":"synthetic-child"}}
```
Subject is optional (defaults to root). Claude/Codex accept root or agent;
OpenCode accepts root or session; selected child session IDs derive their own run,
while rootSessionID provides hierarchy context. Root kind must match rootSessionID.
Ready results include relationship:self/direct/unknown. An observed matching
parent proves a direct relationship; a missing or different immediate parent is
unknown (it may be nested). No relationship is inferred.
Raw native IDs are transient and never returned, logged, or stored.

`continueSessionEvidence` parameters: `{"version":1,"cursor":"opaque"}`.
Every result has version:1 and state. States are ready, absent, pruned,
unavailable, resource_exhausted, stale; clients may also display pending while
awaiting a response. Ready adds snapshotID, head, eventCount, expiresAt (Unix
milliseconds), summary:{events,grounding}, events:[event-v1 bodies], nextCursor.
Cursors bind the immutable snapshot, platform, run, subject, head, count, position,
and expiry. Expiration/eviction returns stale; start a new snapshot explicitly.

Pages contain at most 50 events, with a 60 KiB budget for serialized event entries
(including separator allowance). Snapshot metadata, cursors, and RPC framing are
additional; the transport caps each JSON frame body at 1 MiB. Verification runs in
one read-only worker, with bounded jobs, bytes, events, time, and caches. The WAL
read transaction ends before the first UI page. No synchronous verification fallback is permitted.
Grounding events preserve monthly runs; only future events with an explicit target
are attached. Historical monthly totals are never assigned to sessions. A pruned
monthly receipt establishes only monthly pruning, not session-specific grounding.

For an existing Compass installation, prepare the reader connection independently of
native hook installation:

```sh
node src/cli.mjs companion-enable --home /absolute/home --state-dir /absolute/compass-state
```

This requires the existing writer credential and Compass runtime. It creates or
preserves `reader.key` (0600) in owner-only state (0700) and prepares only the
Compass supervisor wrapper and LaunchAgent plist. Optional `--runtime-dir` selects
an existing runtime. Recognized legacy generated wrappers are upgraded; custom
wrappers/plists and symlink targets are refused before changes. Native hooks,
plugins, settings, instruction files, and installation registrations are untouched.
The command never starts or restarts a service. When `reloadRequired` is true,
explicitly reload the Compass LaunchAgent to activate the configuration. An unchanged
second invocation returns false; that is not a check that a previously prepared
configuration has been loaded.

New installed wrappers pass `--reader-key-file` only when `reader.key` exists.
`node src/cli.mjs reader-key --state-dir /absolute/compass-state` remains a key-only
operation for such wrappers. A manually launched supervisor can instead receive
`serve --socket PATH --key-file WRITER_KEY --ledger DB --reader-key-file READER_KEY`.
Pass only READER_KEY to Conductor. Ordinary uninstall preserves reader credentials;
only `uninstall --purge-state` removes them. For custom state, pass the same explicit
`--state-dir` to `node install/uninstall.mjs`.

The reader health result is `{ok:true,capabilities:{sessionEvidence:1,readerRole:true}}`
when an evidence worker is configured; sessionEvidence is 0 otherwise. Existing
writer health remains exactly `{ok:true}`. Summary events counts non-grounding
observations, summary grounding counts targeted injections, and eventCount is their
sum. Head is SHA-256 over the verified candidate run commitments, not a native
session ID. The response is an observation snapshot, never execution success proof.

Grounding lookup covers UTC month buckets intersecting the default 180-day metadata
retention window. `groundingState:unavailable` means at least one candidate monthly
receipt was pruned; it does not claim the selected session had an event there.
Claude/Codex agent membership requires an authenticated matching parent observation;
when the shared root run has been pruned that membership becomes unavailable.
Reader retentionStatus is verified off the writer and preserves the existing
aggregate shape on success; bounded failure returns a versioned unavailable or
resource_exhausted state. Worker failure never triggers a native service restart.

Public interoperability fixtures are in `test/fixtures/conductor/protocol-v1.json`.
All keys and IDs there are synthetic. `legacy-grounding.json` records the pinned
pre-integration builder output, tested byte-for-byte without regenerating history.

## Exact request and response fields

All request objects are closed. The outer request has `version` (1), `id`
(nonempty string, at most 1024 characters), `method`, `params` (object), and `auth`
(lowercase 64-digit SHA-256 HMAC). Native IDs are nonblank UTF-8 strings no larger
than 1024 bytes. They need not be UUIDs; identity is platform-namespaced.

| Method | Exact params |
| --- | --- |
| health | `{}` |
| status | `{}` |
| metrics | `{}` |
| retentionStatus | `{}` |
| beginSessionEvidence | `{version:1,platform,rootSessionID,subject?}` |
| continueSessionEvidence | `{version:1,cursor}` |

`platform` is `claude`, `codex`, or `opencode`. Subject is the closed object
`{kind,nativeID}`, with the platform-specific kinds described above. Unknown fields,
invalid versions, and root selectors not matching rootSessionID are rejected.

Successful outer responses are `{version:1,id,result}`. Errors instead are
`{version:1,id,error:{code,message}}`; result and error never coexist. Error codes:

| Code | Meaning |
| --- | --- |
| UNAUTHENTICATED | Credential did not authenticate the request |
| PERMISSION_DENIED | Authenticated reader attempted a non-allowlisted method |
| INVALID_ARGUMENT | Invalid method parameters or reused ID with different authenticated content |
| NOT_FOUND | Unknown writer method (reader unknown methods are denied) |
| RESOURCE_EXHAUSTED | Transport response or replay capacity exceeded |
| FAILED | Generic request failure; no native IDs or credentials in the message |

Evidence resource limits normally return a successful outer response with
`result:{version:1,state:"resource_exhausted"}`. Authentication/transport errors are
not evidence absence and should not clear previously indexed native sessions.

| Result field | Presence and meaning |
| --- | --- |
| version | Always 1 |
| state | ready, absent, pruned, unavailable, resource_exhausted, or stale |
| snapshotID | Ready only; opaque snapshot identity |
| head | Ready only; 64 lowercase hex characters committing candidate run heads |
| eventCount | Ready only; total selected events across the immutable snapshot |
| expiresAt | Ready only; Unix milliseconds, never ISO text |
| summary | Ready only; `{events:integer,grounding:integer}` |
| events | Ready only; array of unchanged metadata-only event-v1 bodies |
| nextCursor | Ready only; opaque authenticated string, or null at the last page |
| relationship | Ready only; self, direct, or unknown; unknown is never parent proof |
| groundingState | Values: `available` or `unavailable`. Present on `ready`, `absent`, and `pruned` results after grounding lookup completes; omitted on other result states. |
| reason | Not emitted in v1; clients must not require it or invent a server explanation |

`absent` means no matching observed bodies were found, not proof no activity or
context delivery occurred. `pruned` refers to the selected session run's verified
archive receipt; it does not reconstruct deleted bodies. `unavailable` covers
unsupported/unreadable state, failed verification, worker loss, or insufficient
agent-parent evidence. `stale` is reserved for unrecognized, expired, evicted, or
invalid continuation cursors. The server returns a completed result rather than a
polling token; pending is a local client state while its cancellable RPC is active.
Do not reuse a cursor with another selection. Begin a new snapshot to refresh.

Worker execution admits at most eight jobs (including the active job) and dispatches
one at a time. The five-second watchdog starts at dispatch, including worker startup;
queue wait does not consume that execution budget. With eight admitted jobs, a job
can wait behind at most seven bounded executions. Additional submissions return
`resource_exhausted`. These are service watchdog bounds, not latency guarantees
under event-loop scheduling or machine suspension.

A timeout, crash, or exit settles that generation's active and queued requests as
`unavailable`; requests are not automatically replayed. A later request lazily starts
a fresh worker. Its snapshot cache and cursor key are new, so old continuation
cursors return `stale`; explicitly begin a new snapshot. Deliberate service shutdown
prevents replacements and waits for outstanding worker terminations. Worker loss
does not establish that the underlying ledger is invalid. The v1 response remains
closed and does not add a `reason` field.
