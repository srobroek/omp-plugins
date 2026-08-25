---
name: beads-lifecycle
description: "Bead status transitions and gate beads: when to open, block, defer, or close, and how blocking waits work."
---

# Beads Lifecycle and Gates

LIFECYCLE
| situation | choice |
|---|---|
| runnable work | Keep `status=open`; `bd ready` decides readiness from dependencies and gates. |
| worker starts | Claim atomically; `status=in_progress` and assignee identify live ownership. |
| concrete prerequisite | Add a blocking dependency; do not encode it only in prose or state labels. |
| work intentionally postponed | `bd defer <id> --until ... --reason ...`; deferred work stays out of `bd ready`. |
| issue replaced | `bd supersede <old> --with <new>`; do not close without the replacement link. |
| implementation complete | Close with a factual `--reason`; use `--suggest-next` or molecule continuation only when the caller owns dispatch. |
| residual work exists | Create a `discovered-from` bead before closing the source issue. |
MUST NOT force-close a gated issue: `bd show <id>` names what still blocks it and
  `bd gate check` resolves the automatic gates (timer, `gh:run`, `gh:pr`, bead).
  A force-close is allowed only after an explicit human decision recorded on the
  issue. `bd close` on a gate bead itself is refused by the `bd-close-gate`
  extension; see rule://beads-gate-close.
DEFAULT Use `bd set-state` for an independent operational dimension whose
  transitions need event history; status, assignee, dependencies, and gates
  remain their structured authorities.

HUMANS AND GATES
| need | mechanism |
|---|---|
| a human must answer or dispose of a standalone issue | `bd human` lifecycle on that issue |
| another issue must wait for human approval | human gate blocking the waiting issue |
| wait for time, CI, PR, or cross-repository work | timer, `gh:run`, `gh:pr`, or bead gate |
| serialize integration mechanics | merge slot, not a gate or label |
MUST Run `bd gate check` at mid-run dispatch and recovery boundaries; session
  start is covered by the session-beads-lifecycle extension.
MUST Record the human question, decision, and resulting action in the issue
  comment or gate resolution; approval is not implied by issue closure.
