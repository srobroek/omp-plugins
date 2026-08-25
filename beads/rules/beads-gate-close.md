---
name: beads-gate-close
description: A gate bead is resolved with bd gate resolve; bd close on it skips the gate resolution entirely.
condition:
  - "(?i)\\bbd\\s+gate\\s+(?:list|show)\\b[^\\n]*\\|[^\\n]*\\bbd\\s+close\\b"
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
in the id. This rule therefore fires on one shape only — a gate id piped from
`bd gate list`/`bd gate show` into `bd close` — and never on `bd close` itself.

It used to also match the substring `gate` after `bd close`, which fired on every
`bd close <id> --reason 'gate passed'` and on any id that happens to contain
`gate` (`bdp-gate-probe-7gu` is an ordinary bead in a gate-shaped epic). A word in
a reason is not an issue type, so that alternative is gone: the database, not the
token stream, is what knows an issue type.

`bd-close-gate` is the enforced boundary. On a `bd close` carrying
literal ids it asks the database with `bd show --json` and blocks when any of
them is a gate, so a plain `bd close <gate-id>` is refused whether or not this
rule fired. It fails open by design — shell-variable ids, `bd close` with no id
at all, and an unreachable database all allow the call. Honor the invariant
where neither layer can see: check `bd show <id>` before closing an id you got
from a gate command.
