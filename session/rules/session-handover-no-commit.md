---
name: session-handover-no-commit
description: Handover files are ephemeral; never git-add them.
condition: ["agentic-tools/handovers|git\\s+(add|commit)[^\\n]*handovers/"]
scope: "tool:bash"
interruptMode: always
---
Never commit handover files. They are ephemeral local state under ~/.local/state/agentic-tools/handovers/.
