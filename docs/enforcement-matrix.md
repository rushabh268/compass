# Enforcement Matrix

The policy example defaults to `cooperative`.

Only cooperative shadow mode is implemented. The Enforced column below is a
future design boundary, not a list of available features or configuration flags.

Cooperative mode is not a same-UID security boundary. It coordinates supported
paths but cannot prevent a same-user process from using direct filesystem,
credential, tool, or network access.

| Control | Cooperative (default) | Enforced |
|---|---|---|
| Process identity | Agent uses the operator's identity. | Agent uses an OS sandbox or separate identity. |
| Filesystem | Existing user permissions apply. | Access is restricted to the admitted repository and required runtime paths. |
| Publisher credentials | May remain visible through the operator environment; Compass does not claim containment. | Absent from agent processes and available only to the publication broker. |
| General network | Existing host access remains available. | Direct network access is denied. |
| Model provider | Adapter-visible requests may be observed. Direct access remains possible. | A credentialed gateway reaches exact approved provider origins. |
| MCP reads | Configured clients may connect directly. | The MCP gateway exposes only approved read operations. |
| MCP writes | Existing tools remain usable outside Compass. | Write operations require a valid approval capability through the MCP gateway. |
| Git push | Existing credentials and commands remain usable. | Direct push is denied; the publisher pushes only an approved, sealed commit. |
| Jira, Confluence, and Stash writes | Existing clients remain usable outside Compass. | The publication broker is the only write path. |
| Human approval | Workflow convention only. | A Keychain-backed key signs the payload hash, nonce, target, operation, and expiry using a command unavailable to agent subprocesses. |
| Rollback detection | Cannot detect coordinated rollback of the SQLite database and all same-UID local anchors. | Requires an external, hardware-backed, or remote monotonic anchor unavailable to the agent identity. |
| Ledger append integrity | Authenticates the run commitment and persisted tail in constant time; tail deletion and commitment tampering block append. Middle-row tampering is detected by full reads and audits. | Same local checks, backed by the required external monotonic anchor for rollback detection. |
| Supervisor socket | Local authentication detects unsupported callers where possible. | Authentication plus process isolation prevents agents from obtaining approval authority. |
| Supervisor unavailable | Existing local workflows may continue without an enforcement claim. | Brokered egress and publication remain denied; read-only repository work may continue if sandbox policy permits it. |

Implementing enforced mode would require isolation, credential separation,
gateway routing, broker-only publication, and a verified containment suite.
