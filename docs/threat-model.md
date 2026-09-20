# Threat Model

## Scope

The companion harness supplies selected project context and records limited
activity metadata alongside native coding tools. It does not orchestrate agents
or replace their execution and approvals. This document also defines proposed
controls for later publication and gateway components.
The example policy selects cooperative mode.

Cooperative mode is not a same-UID security boundary. An agent running as the
same operating-system user can bypass adapters, read files available to that
user, invoke tools directly, and use any network access granted to that user.
Cooperative mode improves consistency and visibility; it does not contain a
hostile process.

Cooperative mode cannot detect rollback of the database together with its local commitments.
A same-UID process can restore the SQLite database and all local anchors to a
coordinated earlier state. Enforced mode therefore requires an external,
hardware-backed, or remote monotonic anchor that the agent identity cannot roll
back.

Append verifies the authenticated head and run commitment; full-chain validation occurs on reads and audits, while coordinated rollback remains out of scope.
This constant-time check blocks tail deletion and authenticated run-commitment
tampering before append. Tampering with a middle event is detected by full-chain
operations (`transitionRun`, `listEvents`, `listEventsPage`, and `verifyChain`),
not by an append whose authenticated tail remains intact. Duplicate appends
still authenticate the persisted duplicate row before returning its receipt.

## Protected Assets

- Publisher, provider, MCP, and source-control credentials.
- Human approval keys and approval records.
- Repository contents and publication targets.
- Prompts, tool arguments, tool output, and other potentially sensitive data.
- The integrity of policy decisions and audit metadata.

## Trust Assumptions

- The human operator and the operating system are trusted.
- Agent input, generated commands, tool output, and remote content are
  untrusted.
- Adapters and the supervisor are trusted workflow components, but they cannot
  constrain another process with the same user identity in cooperative mode.
- External provider, MCP, Git, Jira, Confluence, and Stash endpoints are outside
  the local trust boundary.

## Enforcement Modes

### Cooperative (Default)

Adapters and the supervisor observe supported operations. Grounding supplies
redacted, bounded notes and comments through host context interfaces. Source
text can influence a model; escaping markers does not turn it into trusted
instructions. The audit path stores selected metadata, never the raw brief,
prompt, or tool output. Native context history remains controlled by each host.

Agents
retain their existing user identity, filesystem permissions, credentials, and
network routes. Controls in this mode are advisory and bypassable.

### Enforced

This mode is not implemented. The policy schema rejects it. The following
requirements describe what a future implementation would need.

Agents run under an OS sandbox or separate identity with repository-scoped
filesystem access. Agent processes receive no publisher credentials and no
unrestricted network access. Exact approved provider origins, approved MCP
operations, Git push, and Jira, Confluence, or Stash writes are reachable only
through credentialed gateways or the publication broker.

Enforced mode must not be enabled until that isolation and complete mediation
have been verified. Adapter or supervisor hooks alone do not provide enforced
mode.

## Threats And Required Controls

| Threat | Required control |
|---|---|
| Agent reads publisher credentials | Keep credentials outside the agent identity and inject them only into the broker or gateway. |
| Agent sends data to an arbitrary endpoint | Deny unrestricted agent networking and allow gateways to reach exact approved origins only. |
| Agent bypasses publication review | Deny direct Git push and write-capable MCP or SaaS access; make the broker the only publication path. |
| Agent forges or replays approval | Authenticate the local channel and verify a signed payload hash, unique nonce, target, operation, and expiry. |
| Logging captures a secret | Persist only redacted metadata; report a path and rule ID, never the matched value. |
| Agent rolls back audit state | Treat local commitments as cooperative evidence only; enforced mode requires an external, hardware-backed, or remote monotonic anchor. |
| A cooperative control is mistaken for containment | Display the active mode and preserve the same-UID limitation in operator documentation. |

## Credential And Approval Handling

Before enabling new logging, operators must rotate known exposed credentials,
remove plaintext agent-readable copies, quarantine affected transcripts, and
verify retained credential files are mode `0600`. These are operator actions;
this repository must never record credential values.

Broker keys belong in macOS Keychain. Human approval must use a command that is
unavailable to agent subprocesses and sign the payload hash, nonce, target,
operation, and expiry. The verifier must reject altered, expired, or replayed
approvals.

## Acceptance Boundary

The enforced-mode acceptance suite will use synthetic fixtures to prove that an
admitted agent cannot read publisher credentials, connect directly to
publication endpoints, or forge approval through the Unix socket. Until those
tests and the required isolation components exist, the harness remains in
cooperative mode.
