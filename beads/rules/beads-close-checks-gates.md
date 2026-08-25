---
name: beads-close-checks-gates
description: Before closing a bead, check its gates, give a factual reason, and file the residual work first.
condition: ["\\bbd\\s+(?:-C\\s+\\S+\\s+)?close\\b(?![^\\n]*--help)"]
scope: "tool:bash"
interruptMode: never
---
Three things have to hold before a close lands.

GATES. `bd show <id>` names what still blocks the issue, and `bd gate check` is what
resolves the automatic gates (timer, `gh:run`, `gh:pr`, bead). Closing an issue whose
gates are unsatisfied force-closes it, which is allowed only after an explicit human
decision recorded on the issue. Approval is never implied by closure, so the question,
the decision, and the resulting action belong in a comment or the gate resolution.

REASON. Close with a factual `--reason`. It is the only record of why the work ended,
and closed beads are the handover trail for recent work.

RESIDUAL WORK. Work that continues elsewhere needs a `discovered-from` bead created
BEFORE this close, carrying what makes it actionable (`bd comments add <id> -m ...`:
approach, tricky spots, failure triage). The bead is the handover, not a PR body.
