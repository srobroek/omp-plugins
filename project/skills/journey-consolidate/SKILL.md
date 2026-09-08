---
name: journey-consolidate
description: "Use when advancing a journey checkpoint with human approval: flush delta-log entries, prune old runs, and regenerate the index."
---

# journey-consolidate

Consolidation is what keeps journey files small and trusted (FORMAT.md,
"Consolidation checkpoints"). An agent prepares and proposes; **only a
human blesses**. Never consolidate as a side effect of another skill.

Read the journeys directory's normative `FORMAT.md`, config `README.md`, and
`INDEX.md` first. The checkpoint and retained delta window must agree.

## Eligibility

Propose consolidation only for journeys where:
- the latest run is `pass` at the journey's current version (or the user
  explicitly waives this), and
- there is something to flush or prune (Δ entries, excess runs) or
  `status: draft` is ready to become `active`.

## Procedure (per journey)

1. Capture the journey's exact body, version, prior checkpoint, and delta entries
   as the review snapshot. Present the body (or a summary for long journeys),
   proposed new checkpoint (today), and exact Δ ids/content to flush through
   that date, including same-day entries. Include latest run result + date,
   proposed promotion, prune dry-run deletion list, and open findings referencing
   this journey (grep the tracker for `journey-finding` / `journey: J<id>`).
   Open findings are a reason to DEFER consolidation -- surface them.
2. Ask the human to bless this packet per journey (`ask` for batches). No
   blanket approvals for unseen packets. Immediately before applying, compare
   the current journey, run evidence, findings, and prune selection to the packet.
   Any change, including a new/corrected delta or date rollover, invalidates the
   packet: retain all entries and the old checkpoint, refresh eligibility and
   obtain renewed approval. Do not merge unseen edits into an approved snapshot.
3. On approval:
   - flush only the exact approved Δ entries dated on or before the NEW
     checkpoint; never select deletions by date alone or the previous checkpoint,
   - set `last_reviewed:` to that approved date and promote draft → active only
     if agreed, in the same guarded edit as the flush. Preserve every unapproved
     entry. If any remaining entry is dated on/before the proposed checkpoint,
     defer and re-review instead of advancing past it,
   - reject a stale edit rather than overwriting concurrent work; a concurrent
     change requires a fresh packet and approval, not an automatic retry,
   - prune only the approved journey: `python3 <journeys-dir>/journeys.py
     prune <journeys-dir> --journey <journey-directory-name>
     --keep <runs_keep> --yes`. First run the same selection without `--yes`
     and show its deletion list. Use `runs_keep` from README frontmatter.
     The native equivalent is `journeys_index` with that `journey` name.
     Never omit the selector under a per-journey approval.
   - reindex: `python3 <journeys-dir>/journeys.py index <journeys-dir>`,
     then lint. The helper lives in the journeys directory itself.
4. Commit: `journey(J<id>): consolidate — last_reviewed <date>`.

## Report

Which journeys were consolidated (entries flushed, runs pruned), which were
deferred and why (open findings, red run, human declined).
