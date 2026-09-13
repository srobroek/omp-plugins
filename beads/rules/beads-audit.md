---
name: beads-audit
description: "For non-orchestrated Beads work, record semantic events explicitly instead of duplicating automatic field audits."
---

# Beads Semantic Audit and Reporting

## Audit

For non-orchestrated work, rely on Beads' automatic audit for ordinary status,
assignee, priority, and close field changes; do not duplicate those changes as
explicit interactions.

MUST Record semantic events such as assignment decisions, blocked handoffs,
reports, review verdicts, requested changes, approvals, conflicts, merge
outcomes, human decisions, and failures with `bd audit record`.
MUST Encode each entry with `kind=semantic_event`, the owning issue ID, and a
compact JSON response containing string fields `event` and `outcome`; `artifact`
may hold a repository-relative path.
DEFAULT Use `bd audit record --kind semantic_event --issue-id <id> --response
'{"event":"review_verdict","outcome":"approved","artifact":"artifacts/review.md"}' --json`.
Comments carry concise human reasoning and paths; audit entries carry machine
fields. Do not use `bd audit` as the task database.

## Reporting

DEFAULT Use a read-only on-demand reporter for recovery, requested summaries,
and close-out; do not keep one alive between requests.
MUST Give it issue lists, `bd show` and comments, gate and merge-slot state,
`.beads/interactions.jsonl`, and referenced artifacts. It never invents missing
state or mutates the run.

For orchestrated runs, follow the owning package's ledger and lifecycle instead
of adding a parallel `bd audit` stream.
