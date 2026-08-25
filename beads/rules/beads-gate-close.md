---
name: beads-gate-close
description: A gate bead is resolved with bd gate resolve; bd close on it skips the gate resolution entirely.
condition:
  - "(?i)\\bbd\\s+close\\b[^\\n]*gate"
  - "(?i)\\bbd\\s+gate\\s+(list|show)\\b[^\\n]*\\|[^\\n]*\\bbd\\s+close\\b"
scope: "tool:bash"
interruptMode: always
---

A gate bead is not closed with `bd close`. Resolve the gate, then close the step
it blocked:

    bd gate resolve <gate-id>
    bd close <step-id> --reason "..."

Re-verified against bd 1.1.2: `bd close <gate-id>` succeeds and does unblock the
waiting bead, so nothing fails loudly — but no gate resolution is recorded, and
the approval the gate stood for is silently discarded rather than answered. The
only trace left behind is a `close_reason`, which is what an ordinary bead gets.

Detection limit: a gate bead's id is an ordinary bd id (`<prefix>-<suffix>`,
e.g. `sk-gate-probe-7gu`); `issue_type: gate` is the only marker and it is not
in the id. This rule therefore fires on the shapes that reveal the intent — a
placeholder or variable naming a gate, a reason mentioning one, or a gate id
piped from `bd gate list` into `bd close` — not on every `bd close`.

The `bd-close-gate` extension closes the remaining hole: on a `bd close` carrying
literal ids it asks the database with `bd show --json` and blocks when any of
them is a gate, so a plain `bd close <gate-id>` is refused whether or not this
rule fired. It fails open by design — shell-variable ids, `bd close` with no id
at all, and an unreachable database all allow the call. Honor the invariant
where neither layer can see: check `bd show <id>` before closing an id you got
from a gate command.
