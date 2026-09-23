---
name: beads-no-editor
description: Fires when a session is about to run `bd edit`, which opens $EDITOR and hangs a non-interactive agent session.
condition: ["^\\s*(?:[A-Z_][A-Z0-9_]*=\\S*\\s+)*(?:sudo\\s+)?bd(?:\\s+-C\\s+\\S+|\\s+--directory\\s+\\S+)?\\s+edit\\b(?!\\s+(?:--help|-h)\\b)"]
scope: ["tool:bash", "tool:eval"]
interruptMode: always
---

`bd edit` opens `$EDITOR` and waits for it to exit. No agent session can satisfy
that, so the command hangs until the session is killed. It is wrong whenever it
appears, in every repository and for every actor, which is why this interrupts
rather than advises.

MUST set the field directly instead. Use `bd update ID` with the flag for the
field, or `bd comment ID "TEXT"` to add prose. Read the current value first
with `bd show ID --json`.

NEVER work around this by exporting an editor: `EDITOR=true bd edit ID` opens a
no-op editor, so the edit silently records nothing.
