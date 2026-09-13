---
name: speckit-workflow
description: Load for SpecKit work or repositories containing `.specify/`; route active specs through beads molecules without authoring tasks.md.
---

The upstream /speckit.* skills are unmodified; they still talk about tasks.md.
This layer redirects them: state lives in beads, never tasks.md. The poured
molecule is the phase DAG and the only statement of step order.

EXECUTION
MUST Invoke SpecKit commands through their runtime-native skill interface.
NOT Invoke deprecated `/speckit.implement`.
MUST For lean/feature with `agent_assign=yes`, use the runtime-native
  agent-assign chain (assign -> validate -> execute).
MUST For `speckit-basic` or `agent_assign=no`, work the task beads directly
  under the unconditional `implement` step.
MUST Begin implementation child work only after the implement step's
  prerequisites are satisfied, including every unwaived analysis approval gate.
NOT Proceed with open questions, unresolved gaps, or unapproved intent changes.

SETUP
MUST Copy every `formulas/*.formula.toml` from this plugin into `.beads/formulas/`
  (the `speckit-setup` skill / `speckit_setup` tool does this). Keep `mol-`
  prefixed filenames — `bd mol bond` resolves only prefixed stems.
DEFAULT Without a beads workspace, preserve upstream SpecKit artifact behavior.

SPEC IDENTITY
MUST Set `--spec-id <NNN-slug>` on every bead a spec produces, including
  `bd update` after `bd mol pour`.

MOLECULE PER FEATURE
MUST Pour one molecule per spec dir. Profiles: `speckit-basic`,
  `speckit-lean`, `speckit-feature`. All take `autonomous` and
  `agent_assign`. `bd mol pour <profile> --var feature=<NNN-slug>`, then
  `bd update <root-id> --spec-id <NNN-slug> --metadata '{"spec_dir":"specs/<NNN-slug>"}'`.
DEFAULT Track position with `bd mol current <root-id>`.

SPEC START
MUST At `/speckit.specify`, query parked work (`bd list --status deferred --json`)
  and surface hits before writing the spec.
MUST Pour a molecule before writing the spec. Profiles live in this plugin's
  `formulas/`; `bd cook <name>`. Use `--var agent_assign=no` if that extension
  is missing. Validate `autonomous` and `agent_assign` as exactly `yes` or `no`
  before pouring.

TASK STATE
MUST When /speckit.tasks instructs writing specs/*/tasks.md, create beads
  instead: `bd create "T00N <title>" --parent <implement-step-id> --spec-id
  <NNN-slug> -t task`. Bulk `bd create -f <tmp>.md` OUTSIDE specs/.
MUST When a later phase instructs reading tasks.md, query beads:
  `bd query 'spec_id="<NNN-slug>"' --json`.
MUST Keep the implement parent open until every implementation child is closed.

GATES
MUST Resolve a human gate with `bd gate resolve <gate-id>` then `bd close <step-id>`.
MUST Use `--var autonomous=yes` only after explicit user authorization to waive
  this run's human approval gates; record the waiver on the molecule root.
DEFAULT Use `autonomous=no`; unattended mode or an unavailable human is not a
  waiver. Without authorization, preserve the blocked gate and report the wait.
MUST For each waived gate, record on its preceding step the review findings and
  what a reviewer would have been asked. Run all verification regardless of waiver.
NOT `bd close <gate-id>` to resolve a gate; the `bd-close-gate` extension checks
  literal ids against the database and blocks gate closure.

COMMAND ROUTING (was the dispatcher table)
- constitution / roadmap.write: project-scoped; do not pour a molecule.
- tinyspec: no lifecycle; do not pour. If it grows, stop and pour a feature molecule.
- bugfix.report: active spec -> `bd mol bond mol-speckit-bugfix`; no spec -> create
  the spec dir first. The patch step's tasks.md write is denied -- create beads.
- brownfield.bootstrap: read legacy tasks.md; import once as beads; never write it.
- cleanup / cleanup.run / converge / iterate.apply / reconcile.run / refine.propagate:
  their tasks.md writes are denied. Create children of the implement step instead.
- analyze: run inline (not a subagent); task state from `bd list --spec`.
- review.run / qa.run: bond `mol-speckit-fix-findings` for code defects; converge
  for NEVER-built requirements.
- retro.run: read beads (`bd list --spec --status all --json`), close reasons,
  wisps, and decision beads -- not only spec.md/plan.md.

PR REVIEW LOOP
MUST The agent that creates a PR owns automated review through landing or human
  escalation. Park pending CodeRabbit, Codex and repository-configured review
  waits without polling; unrelated spec work continues.
MUST Collect every actionable finding at the exact head into one fix round, push
  the update, rerun all configured reviewers, resolve addressed GitHub threads
  through `resolveReviewThread`, and read back `isResolved=true`.
MUST Count attempts per material issue using the review-thread node id, or a
  stable finding fingerprint when no thread exists. New findings start at one.
MUST After three unsuccessful fixes of the same issue, hold that PR at human
  review with the issue identities, attempts, heads, fixes and unresolved URLs,
  then notify the main agent loop. Never charge new issues against the old count.

DECISIONS
MUST Register a hard-to-reverse choice when it lands (`adr` skill / decision bead).
Phases that earn a record: plan, critique/security, analyze, implement, iterate.

SUB-PROCESS MOLECULES
MUST Bond, do not pour loose: `bd mol bond mol-speckit-<name> <target-id> --var feature=<NNN-slug>`.
Bond to the STEP that found the work so the first child is ready immediately.

build-formula lives in the beads plugin. Do not duplicate it here.
