# Automatic grounding workflow

Claude Code, Codex, and OpenCode share project-note selection, current
working-tree comment reads from files changed in the latest commit, redaction,
marker escaping, budgets, and source references. A brief enters the native
context interface; only selected metadata enters the audit ledger.

```mermaid
sequenceDiagram
    autonumber
    actor Developer
    participant Host as Native coding tool
    participant Adapter as Companion adapter
    participant Grounding as Shared grounding
    participant Sources as Project sources
    participant Ledger as Supervisor + ledger
    participant Dashboard

    opt OpenCode background refresh, independently of requests
        Adapter->>Grounding: Refresh context cache
        Grounding->>Sources: Bounded notes + comment reads
        Sources-->>Grounding: Selected source text
        Grounding-->>Adapter: Redacted, cited, budgeted cache entry
    end
    Developer->>Host: Request
    Host->>Adapter: Supported context callback
    alt Claude Code or Codex native context event
        Adapter->>Grounding: Collect fresh brief
        Grounding->>Sources: Bounded notes + comment reads
        Sources-->>Grounding: Selected source text
        Grounding-->>Adapter: Redacted, cited, budgeted brief
    else OpenCode system transform
        Adapter->>Adapter: Read prepared cache only (no source I/O or RPC)
    end
    opt Nonempty brief available
        Adapter-->>Host: Brief through supported context interface
        Adapter->>Ledger: Best-effort emission metadata (never raw brief)
    end
    Note over Host,Adapter: Disabled, no match, cold cache, or failure: continue without extra context
    Host->>Host: Native model/tool execution and approvals
    Host->>Adapter: Selected activity callbacks/events
    Adapter->>Ledger: Normalize + inspect; selected metadata only
    Host-->>Developer: Result
    opt Dashboard is open
        Dashboard->>Ledger: Poll recent aggregate counts
        Ledger-->>Dashboard: Bounded recent event window
    end
```

## Native context hooks

The installer adds separate synchronous grounding commands for `SessionStart`,
`UserPromptSubmit`, and `SubagentStart`. They return only
`hookSpecificOutput: { hookEventName, additionalContext }`; they never make
approval or control decisions. Existing silent telemetry callbacks remain
separate. No transcript files are opened to construct a brief.

The complete native process has a one-second deadline. The complete brief,
including wrappers, is capped at 8,192 UTF-8 bytes, with smaller configured
budgets respected. A brief must fit its safety wrappers, a complete source heading,
and some source content; a smaller ceiling produces no output. The Codex grounding registration sets
`additionalContextLimit: 0` because the producer enforces this complete-output
ceiling; no other native limits are changed. Source traversal and reads are bounded; symlinks,
nonregular source files, and paths escaping the selected roots are rejected.
Grounding fails open when configuration, sources, or collection are unavailable.
Audit connection failure does not suppress available context.

Claude Code persists additional-context reminders. Codex supplies developer
context with history managed by its host. OpenCode's cached system transform
is ephemeral and creates no persisted conversation Part. The companion does
not edit host histories to make these retention behaviors identical.
These are per-emission limits. Repeated native callbacks may supply the same
context again, and Compass does not impose a cumulative host-history budget.

## Audit boundary

Grounding events contain source references, match reason, sizes, and timing
metadata, with platform-separated identities, per-occurrence IDs, and UTC-month
run epochs. No raw brief, prompt, or tool output is sent to the ledger. Retrying
the exact same event is deduplicated; separate emissions stay separate.

An emission record is evidence that context was supplied, not that the model
used it or that the resulting change is correct. Audit delivery remains best
effort. The dashboard's counts cover a bounded recent window, not lifetime totals.
OpenCode keeps at most 256 recent injection records between periodic drains and
attempts one final drain on disposal. Overflow drops the oldest records without
counting the loss, so recorded totals are a lower bound on emissions. Shutdown
or queue/RPC failures can also lose telemetry; available context is not withheld
because its audit record cannot be delivered.

## Host references

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)

## Session targeting

Grounding keeps monthly run IDs for retention. When a native callback provides
an explicit valid session/agent identity, `sessionHMAC` identifies that target and
the event/dedupe identity includes its hash. No-target events retain the exact
historical bytes and remain unassigned; monthly totals cannot establish session
usage. Claude and Codex use the same subject selector as their telemetry adapters.
OpenCode's system-transform callback carries its optional `sessionID` into each
immutable injection entry; simultaneous sessions do not share a current-session
variable. Missing identity stays unassigned. This instrumentation does not activate
hooks or change native configuration.
