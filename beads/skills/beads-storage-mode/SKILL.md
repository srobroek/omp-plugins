---
name: beads-storage-mode
description: Explains the embedded Beads store and the session BEADS_DIR pin. Use when configuring or troubleshooting Beads storage.
---

# Beads Storage Mode

TRIGGER
+ Configuring or troubleshooting Beads storage
- Dolt server administration → no external server is supported

## Rules

MUST Use the embedded `.beads` store.
MUST Let the session lifecycle pin `BEADS_DIR` to the repository's canonical `.beads` store so linked worktrees share one ledger.
MUST NOT start or configure a Dolt server.
