---
name: beads-storage-mode
description: Explains the embedded Beads store and the session BEADS_DIR pin. Use when configuring or troubleshooting Beads storage.
---

# Beads Storage Mode

TRIGGER
+ Configuring or troubleshooting Beads storage
- Dolt server administration → no external server is supported

## Rules

MUST Use the embedded `.beads` store, whose mode is committed in `.beads/metadata.json`.
MUST Let the session lifecycle pin `BEADS_DIR` to the repository's canonical `.beads` store so linked worktrees share one ledger.
MUST Read every `bd` call this plugin shapes -- its own runs, and every `bash` tool call it pins -- as resolving to that committed pin: an inherited `BEADS_DOLT_SHARED_SERVER` is cleared, so a shell export cannot route the call to a shared server.
NOT A raw subprocess that builds its own environment (a spawned script, an `eval`, a detached run) is outside that reach and still follows the export; reach the committed store with `env -u BEADS_DOLT_SHARED_SERVER bd ...`.
