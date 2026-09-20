# Compass

A local companion for **Claude Code, Codex, and OpenCode**. It collects selected
activity metadata in a shared audit ledger, inspects hook payloads for credential
patterns, supplies automatic grounding from project notes and code comments,
and provides a small local dashboard across all three adapters.

Your coding tool keeps its native harness: the agent loop, tools, sessions,
sandbox, and approvals. This project connects through the extension points that
tool exposes. It does not replace that runtime or decide which agents to run.

**Cooperative shadow mode only.** The adapters record observations; they do not
block actions or enforce destination policies. Processes running as the same OS
user can bypass them. See [SECURITY.md](SECURITY.md).

## Capabilities

| Capability | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Session/tool metadata and credential-pattern observations | Command hooks | Command hooks | Plugin events/hooks |
| Shared authenticated ledger and dashboard | Yes | Yes | Yes |
| Automatic project-note/comment grounding | Native additional context | Native additional context | Cached system transform |
| Noisy-event coalescing | N/A: command callbacks | N/A: command callbacks | Yes: message/watch/PTY streams |
| Blocks actions or grants approvals | No | No | No |

Event coverage depends on the client. This is not a complete record of every
operation: unsupported paths, disabled hooks, timeouts, and full queues can lose
observations. A recorded event does not prove that the resulting code is correct.

## Requirements

- **macOS** for the installer and launchd integration. Linux and Windows
  installation are not currently supported.
- Git and npm/npx. The installer fetches its own Node **24.19.0** runtime.
- A selected coding client with the documented hook/plugin interface. Codex
  must support `hooks.json`, command hooks, and `async` hooks; see the
  [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).
- For development, Node **>=24.19 and <25**. The ledger uses `node:sqlite`.

The OpenCode integration targets **1.18.20**. Native command hooks follow the
[Claude Code hook reference](https://code.claude.com/docs/en/hooks) and
[Codex hook reference](https://learn.chatgpt.com/docs/hooks). Review hook changes
when updating a client; context lifecycle and event coverage remain host-owned.

## Install

Clone [rushabh268/compass](https://github.com/rushabh268/compass) to a stable location: installed commands refer to that
checkout. First inspect what the installer would configure:

```sh
./install.sh --adapters claude,codex,opencode --dry-run
```

Existing Agent Harness users: read [the migration guide](docs/migration.md) first.
The installer refuses recognizable legacy registrations instead of starting a
second supervisor or duplicating hooks.

Then choose the clients you use:

```sh
# Codex only
./install.sh --adapters codex

# All three clients
./install.sh --adapters claude,codex,opencode
```

Without `--adapters`, installation selects `claude,opencode` and leaves Codex
configuration untouched. Use `--codex-home /path/to/codex-home` for a custom
Codex configuration directory; otherwise `CODEX_HOME`, then `~/.codex`, is used.

The installer creates:

- A pinned runtime under `~/.local/share/compass-runtime`.
- Private state under `~/.local/state/compass`: an existing key and policy
  files are preserved; a missing key is generated with mode `0600`.
- A `local.compass` launchd agent and supervisor wrapper.
- Managed registrations in only the selected clients: Claude's `settings.json`,
  Codex's `hooks.json`, and/or OpenCode's `opencode.jsonc`.
- A marked environment block in `.zshenv` when OpenCode is selected, and backups
  before configuration edits.

Existing unrelated settings and hooks are preserved. The installation manifest
records selected adapters and configured Codex hook-file locations for later
cleanup, including custom homes. The installer does not change Codex models,
permissions, MCP servers, or hook trust decisions.

**After installing Codex hooks, review and enable the new commands in `/hooks`.**
Codex can skip new or modified hooks until their exact configuration is trusted.
The installer does not bypass that review. Restart OpenCode to load its plugin;
start a fresh shell/session where necessary to load the environment settings.

Advanced flags: `--home`, `--skip-runtime`, and `--skip-launchd`. Use the last two
only when you provide the runtime or manage the supervisor yourself. Installation
does not automatically migrate a different, pre-existing launchd service.

## Check the supervisor and open the dashboard

```sh
~/.local/share/compass-runtime/node_modules/node/bin/node \
  src/cli.mjs health \
  --socket "$HOME/.local/state/compass/supervisor.sock" \
  --key-file "$HOME/.local/state/compass/auth.key"

~/.local/share/compass-runtime/node_modules/node/bin/node \
  src/cli.mjs dashboard \
  --socket "$HOME/.local/state/compass/supervisor.sock" \
  --key-file "$HOME/.local/state/compass/auth.key"
```

Open the printed URL, normally `http://127.0.0.1:7071`; `localhost:7071` is also
accepted. Ctrl+C stops the dashboard. `--port` and `--refresh-seconds` are optional.

The dashboard uses authenticated RPC and displays aggregate metadata from the
last **2,000 surviving events**. The supervisor caches this result for **10
seconds**. Browser polling pauses when the tab is hidden. Counts describe that
recent event window, not lifetime totals, throughput rates, or productivity.
The dashboard runs only when invoked; the installed supervisor runs separately.

For a synthetic end-to-end check, the `canary` command tests all three
translators, authenticated RPC, persistence, immutable-event replay, and ledger
integrity. It adds three synthetic events to the specified ledger:

```sh
~/.local/share/compass-runtime/node_modules/node/bin/node \
  src/cli.mjs canary \
  --socket "$HOME/.local/state/compass/supervisor.sock" \
  --key-file "$HOME/.local/state/compass/auth.key" \
  --ledger "$HOME/.local/state/compass/events.sqlite"
```

## Automatic project grounding

Grounding reads Markdown notes from `.compass/notes` in the main checkout.
For example:

```text
your-project/
  .compass/notes/
    credential-refresh/
      decisions.md
      status.md
```

The branch is matched to a note folder by a ticket identifier found in its text,
then by folder-name overlap. A single note folder is a fallback when no match is
found. Linked and nested worktrees share the main checkout's notes.

To keep notes elsewhere, set `COMPASS_NOTES_DIR` in the coding tool’s environment.
An absolute path selects that directory; a relative path is resolved from the
main checkout. Unset or empty uses `.compass/notes`.

`~/.local/state/compass/grounding.json` controls the feature:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "tokenBudget": 256,
  "deadlineMs": 100,
  "sources": ["project-notes", "repo-comments"]
}
```

The installer creates this enabled example only if absent. A missing or invalid
configuration disables grounding. Set `enabled` to `false` to disable it. File
location can be overridden by `COMPASS_GROUNDING_CONFIG`.

Repository comments currently come from working-tree files selected by
`git diff HEAD~1 HEAD`; this is not a repository-wide search or a search across
all uncommitted files. Each source file is capped at 64 KiB, with file and
directory count limits. `tokenBudget` uses a four-bytes-per-token approximation,
not a model tokenizer. `deadlineMs` bounds individual Git commands, not the total
filesystem refresh.

All three adapters use the same source selection, redaction, marker escaping,
and source references. Claude Code and Codex register separate synchronous
context handlers on `SessionStart`, `UserPromptSubmit`, and `SubagentStart`.
Each invocation prepares a fresh brief and returns only the host's documented
`hookSpecificOutput.additionalContext` envelope. The whole native process has a
one-second budget, including stdin and optional audit delivery; the complete
brief is capped at 8,192 UTF-8 bytes including wrappers. A smaller configured
token budget also applies. These handlers never return approval decisions.

OpenCode warms its cache in the background on activity and periodic refreshes.
Its `experimental.chat.system.transform` reads only the cached brief, without
Git, filesystem, or socket work on that path. A cold cache contributes no brief.
Missing sources, disabled or invalid configuration, and collection failures
leave the native workflow running without additional context.

Context retention belongs to the host. Claude Code persists additional-context
reminders; Codex supplies developer context under its own history management.
OpenCode's system transform is ephemeral and creates no persisted conversation
Part. Grounding can send selected, redacted text to the configured model provider.
The ledger receives only source references, match reason, sizes, and timing
metadata; it never receives the raw brief. Context output does not depend on a
healthy audit connection, and an emission record does not prove model use.

See the [grounding workflow](docs/grounding-workflow.md) for the two information
flows and host-specific integration boundary.

## Codex event collection

The adapter accepts these documented events:

```text
SessionStart       SessionEnd        SubagentStart    SubagentStop
PreToolUse         PostToolUse       PermissionRequest
PreCompact         PostCompact      UserPromptSubmit Stop   Interrupt
```

The separate telemetry command hooks run in the background, except `SessionEnd`, which Codex
always runs synchronously. The registration sets a three-second host timeout;
the adapter uses one one-second budget for stdin and supervisor RPC waits.
Process startup and synchronous parsing/scanning still cost time.

Codex limits background hooks to eight per session and may cancel unfinished
hooks when a session ends. Delivery is best effort. The telemetry runner is silent, returns
no hook decisions or context, and never opens transcript files. Payloads above
1 MiB, excessive nesting, malformed JSON/UTF-8, unsafe keys, or unavailable
supervisors are dropped.

Every callback gets a new occurrence identity. Tool-call IDs correlate phases;
they do not collapse separate invocations into a single event. Retrying the exact
same constructed event is deduplicated by the ledger.

## Data and failure behavior

Audit events use a closed schema. Session IDs, tool IDs, and repository paths
are HMAC-labeled; unknown tool names are HMAC labels. The adapter scans raw
payloads in memory but retains no raw prompt or tool output. Pattern detection
can miss secrets, and relative grounding paths can still reveal project details.

The ledger provides tamper evidence, not protection against every process
running as your user. Keep the key with the ledger when making a protected
backup. **Do not overwrite the key** to fix a connection problem.

OpenCode coalesces selected noisy events while preserving supported lifecycle,
tool, permission, error, and DLP observations. Queues are bounded and can drop
events under pressure. Retention is explicit and run-based; no automatic pruning
schedule is installed. Events in long-lived global runs can remain longer than
their individual ages would suggest. `retention-status` and `prune --dry-run` are
available through the CLI; inspect their output before choosing a prune action.

If the supervisor appears unavailable, check:

```sh
launchctl print "gui/$(id -u)/local.compass"
```

Then check the health command and the local supervisor error log. If Codex events
are missing, check `/hooks`, the selected configuration home, and client version
first. If an integration affects latency, measure the relevant hook path and
compare with it disabled; fail-open is not a zero-overhead guarantee.

## Uninstall

```sh
./uninstall.sh
```

This removes this checkout's managed registrations from all clients, unloads the
common supervisor, and removes its wrapper/plist and marked environment block.
Unrelated settings and subsequent user edits are preserved. Runtime state and
configuration backups remain. `--purge-state` additionally deletes the private
state directory, including its key and ledger; use it only when that deletion is
intended. `--dry-run` shows the plan.

Keep `installation.json` in the private state directory until uninstall. If it
is deleted, client hooks require manual cleanup: uninstall does not claim
ownership of unrecorded registrations or inspect unselected client settings.

## Development and license

```sh
npm ci
npm test
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[threat model](docs/threat-model.md). This project is licensed under [MIT](LICENSE).
