# Security

This project currently implements **cooperative shadow mode**. It records
selected metadata and credential-pattern observations. It does not block tool
actions, enforce destination policies, isolate agents, or replace the native
coding tool's sandbox and approval system.

## Reporting a vulnerability

Please do not post credentials, private source, session transcripts, or an
unredacted exploit report in a public issue. If the repository's Security tab
offers **Report a vulnerability**, use that private channel. Otherwise open an
issue asking the maintainer for a private reporting channel, without including
sensitive details. Include affected versions and a synthetic reproducer when a
private channel is established.

Only the current release line is maintained. Hook interfaces change; report
the coding-tool version as well as the Agent Harness version.

## What the controls establish

- Authenticated local RPC and closed event schemas limit the accepted event
  format. Unknown labels and identifiers are HMAC-labeled where required.
- The SQLite ledger authenticates per-run chains. This detects specific
  tampering; it cannot detect coordinated rollback of the database and all
  local commitments by another process with the same OS identity.
- Raw hook payloads are inspected in memory and are not stored by the audit
  adapter. Detection is pattern-based and can miss secrets. Metadata, including
  relative grounding source paths, may itself be sensitive.
- Grounding across Claude Code, Codex, and OpenCode sends selected, redacted
  note/comment text through the host context interface to the
  configured model provider. This is separate from metadata-only persistence.
  The native host controls context retention; only OpenCode’s system transform
  promises ephemeral injection. Delimiters and redaction do not make untrusted
  notes safe to obey. An emission record does not prove that a model used it.
- The dashboard binds to IPv4 loopback and validates the Host header. It is
  intended for a single-user workstation, not a multi-user access boundary.

The state directory and key must remain private. Do not replace an existing
key to troubleshoot a connection: existing ledger integrity checks depend on
that key. Keep the key and ledger together in any protected backup.

## Failure and coverage limits

Hooks are best-effort observers. Timeouts, queue limits, background-hook
cancellation, and client-specific event coverage can lose observations. A
missing event does not prove that no action occurred. Fail-open behavior also
does not imply zero latency or immunity to integration bugs.

Enforced mode, approval brokering, and network gateways are **not implemented**.
The proposed requirements are separated from current behavior in the
[threat model](docs/threat-model.md) and
[enforcement matrix](docs/enforcement-matrix.md).
