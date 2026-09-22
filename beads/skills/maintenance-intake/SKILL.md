---
name: maintenance-intake
description: Use when asked to run housekeeping, process the maintenance backlog, or orchestrate incidental issues.
---

# Maintenance Intake

TRIGGER
+ "run housekeeping"
+ "process the maintenance backlog"
+ "orchestrate incidental issues"
- one issue required by the current feature epic -> keep it in that epic

GATES
LOAD `skill://orchestrate-with-bd`. If the companion skill or its `orc_bind`,
`orc_status`, and `orc_release` tools are unavailable, stop and report the missing
companion.
ASK before scheduling unattended recurring runs.

## Workflow

1. Run `bd info --json`. Read `config.issue_prefix` and form the root ID as
   `"<prefix>-maintenance"`.
2. Run `bd show "<prefix>-maintenance" --json`. If absent, run
   `bd create "Maintenance intake" --id "<prefix>-maintenance" --force --type epic --labels maintenance-intake --description "Standing queue for incidental work. Keep this epic open and release it after each bounded drain." --json`.
   A concurrent creator may win. In every case, re-read the root and continue only
   when it is an open, parentless epic labeled `maintenance-intake`. Stop if it has
   any other shape.
3. Run `bd list --parent "<prefix>-maintenance" --all --json`. Stop if any
   direct child is not a task. Record every blocked or deferred child for the
   final report.
4. Run `bd ready --parent "<prefix>-maintenance" --unassigned --json`. If it
   returns no tasks, repeat step 3, report all residual direct children, and stop.
5. Bind the existing orchestrate lead to `"<prefix>-maintenance"`. Follow its
   `orc_status` flow through the current-generation DAG review and each work wave.
6. Check `orc_status`. Continue while any child is ready or in progress.
   Guarded-release the root with `orc_release` after the drain. Keep it open for
   later intake.
7. Repeat step 3. Report blocked and deferred direct children, plus any open or
   ready child filed across the release race.

## Rules

MUST Dispatch only direct task children of the maintenance root.
MUST Keep each child unassigned until a worker claims it.
MUST Preserve the child's `discovered-from` dependency on its source bead.
MUST Use the existing run-scoped orchestrator.
NOT Add a pool-scoped pull path.
MUST Release the root after a bounded drain.
NOT Close the maintenance root.
NOT Start a background daemon when an agent files a child.
NOT Move work required by an active feature epic into maintenance intake.
