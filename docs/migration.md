# Moving from Agent Harness to Compass

Compass is the new name. Fresh installs use `compass`, `local.compass`,
`~/.local/state/compass`, `~/.local/share/compass-runtime`, and `.compass/notes`.
Installation does not automatically copy or move old data, rewrite legacy hooks,
transfer Codex trust, or stop another installation.

## Keep an existing installation working

Existing commands can continue to use the old checkout and supervisor. Updated
adapter code accepts each `AGENT_HARNESS_` environment variable as a fallback for
its `COMPASS_` equivalent: `SOCKET`, `KEY_FILE`, `STATE_DIR`, `COALESCING_CONFIG`,
`GROUNDING_CONFIG`, and `NOTES_DIR`. The Compass value wins whenever present,
including an empty or invalid value. Invalid policy paths fail closed; an empty
notes override selects the new `.compass/notes` default.

To keep legacy notes, explicitly set `COMPASS_NOTES_DIR=.agent-harness/notes`
in the coding tool's environment. Relative notes paths resolve from the main
checkout, including when the tool runs in a linked worktree. Compass never
combines old and new vaults or searches old locations implicitly.

Keep explicit legacy configuration paths or set `COMPASS_STATE_DIR` to the old
state directory when running adapters against old configuration. An old shell
block normally exports per-file config paths, not `AGENT_HARNESS_STATE_DIR`.
The state-directory variable chooses adapter policy defaults; it does not change
installer paths or replace the CLI's required `--socket` and `--key-file` flags.
Custom installer runtime/state paths are not exposed as command-line flags.
`--home` relocates installer defaults and `--codex-home` selects Codex settings.

## Replace a managed installation manually

1. Keep the original checkout in its installed location. Save the exact existing
   configuration and review its original `uninstall.sh --dry-run` output. Use the
   original `--home`/`--codex-home` where applicable. A renamed checkout produces
   different absolute hook commands and cannot reliably remove registrations.
2. Stop coding-tool sessions using the old hooks/plugin. Run **the original
   version's** `uninstall.sh` **without `--purge-state`**. It removes its launchd
   agent, wrapper, manifest, and exact registered commands while preserving the
   old state and runtime. For hand-managed or custom installations, remove their
   exact registrations and stop their supervisor yourself. Check custom Codex
   homes and OpenCode plugin URLs as well as shell environment blocks.
3. Decide whether to keep history separate or move it. A fresh Compass install
   leaves retained legacy history alone. To reuse history, stop every writer,
   make a consistent SQLite backup (including outstanding WAL data), and preserve
   the **original authentication key together with the ledger**, policies, and
   permissions. Place those files in the Compass state directory before installing.
   Do not copy an installation manifest: it contains obsolete command paths.
   This is an operator-led data migration; the installer does not perform it.
4. Inspect Compass's `./install.sh --dry-run`, then install selected adapters.
   Existing key/policy files at the new destination are preserved. Review new
   Codex commands in `/hooks`, restart OpenCode, and start fresh shells. Run
   `health` and `verify` with the intended explicit socket/key paths before
   deleting any backup or old state.

The installer rejects a legacy default launchd plist, wrapper, installation
manifest, selected-client legacy hook assignments, a legacy OpenCode shell
block, or a plugin URL ending in `/agent-harness/adapters/opencode/server.js`.
It does so before runtime installation, state creation, or configuration edits,
including during dry-run. Retained ledger/key/runtime files alone are allowed.
The guard cannot identify every hand-written command, arbitrary checkout name,
or unselected custom client home; inspect those registrations during migration.
Backups are never restored over later user changes. New backups use
`.compass.bak`; legacy `.agent-harness.bak` files remain recognized when deciding
whether an empty pre-existing configuration should be kept.

## Stable data identities

`HarnessMetrics` and `coalescing.harnessMetrics` remain protocol/JSON identifiers.
The coalescer's legacy fallback HMAC key bytes, all HMAC domains and framing,
SQLite schema, manifest format, RPC version, and grounding safety fences remain
unchanged. Changing these merely for branding would break event identity,
history verification, or client interoperability. The legacy notes directory
remains ignored by Git to prevent accidental publication.
