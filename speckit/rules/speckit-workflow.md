---
name: speckit-workflow
description: Load for SpecKit assets under `specs/` or `.specify/`; route active specs through beads molecules without authoring tasks.md.
globs: ["specs/**", ".specify/**"]
---
## Activation

This rule routes for both `specs/**` and `.specify/**`. A matching path does not activate every section.

- For a read-only asset inspection, apply only `DEFAULT` and `SPEC IDENTITY`.
- For a lifecycle command, apply only the sections named by `COMMAND ROUTING`.
- Do not execute setup, molecule, task, gate, review, decision, or sub-process instructions unless the active command names that section.


The upstream /speckit.* skills are unmodified; they still talk about tasks.md.
This layer redirects them: state lives in beads, never tasks.md. The poured
molecule is the phase DAG and the only statement of step order.

EXECUTION (lifecycle commands only)
MUST Invoke SpecKit commands through their runtime-native skill interface.
NOT Invoke deprecated `/speckit.implement`.
MUST Work the task beads directly under the unconditional `implement` step.
MUST Begin implementation child work only after the implement step's
  prerequisites are satisfied, including every unwaived analysis approval gate.
NOT Proceed with open questions, unresolved gaps, or unapproved intent changes.

SETUP (`speckit_setup` only)
MUST Copy every `formulas/*.formula.toml` from this plugin into `.beads/formulas/`
  (the `speckit-setup` skill / `speckit_setup` tool does this). Keep `mol-`
  prefixed filenames; `bd mol bond` resolves only prefixed stems.
DEFAULT Without a beads workspace, preserve upstream SpecKit artifact behavior.

SPEC IDENTITY (spec-producing commands)
MUST Set `--spec-id <NNN-slug>` on every bead a spec produces, including
  `bd update` after `bd mol pour`.

MOLECULE PER FEATURE (spec-producing commands)
MUST Pour one molecule per spec dir. Profiles: `speckit-basic`,
  `speckit-lean`, `speckit-feature`. All take `autonomous` and
  `agent_assign`. Pass an explicit `--var autonomous=<yes|no>` when pouring,
  then `bd update <root-id> --spec-id <NNN-slug>
  --set-metadata spec_dir=specs/<NNN-slug>`.
DEFAULT Track position with `bd mol current <root-id>`.

MUST Use `speckit_start` for runtime-native workflows or the plugin's
  `tools/spec-start.ts` CLI for workflow start and resume.
MUST On `CHOICE_REQUIRED` or `MIGRATION_REQUIRED`, ask the returned question
  and supply only the explicit user answer and decision when invoking it again.
SPEC START (new or resumed spec lifecycle, CLI and runtime-native skills)
MUST Before pouring, bonding, or advancing, find the spec's existing molecule root;
  read its metadata if one exists.
MUST Reuse a recorded `human_approvals` choice of exactly `yes` or `no`.
MUST If no choice is recorded, ask: "Require routine human approval checkpoints
  for this spec/run? Yes or no." Wait for an explicit answer before creating gates.
MUST Map `human_approvals=yes` to `autonomous=no`, and `human_approvals=no`
  to `autonomous=yes`. Neither unattended mode nor human unavailability is an answer.
MUST Persist the choice with `bd update <root-id> --set-metadata human_approvals=<yes|no>
  --set-metadata autonomous=<no|yes> --append-notes "<explicit user decision>"`,
  retaining `spec_dir`; read back with `bd show <root-id> --json` before advancing.
MUST Stop on invalid or contradictory recorded values; obtain an explicit correction
  without changing the existing gate graph silently.
MUST Report the spec/run, both selections, the enabled routine checkpoints,
  and that reviews, tests, and consequential safety/provider confirmations remain required.
MUST On an existing gated run, obtain explicit migration authorization before
  changing its recorded choice. Record the decision and preserve gate history.
NOT Silently resolve or force-close existing human gates during migration.
MUST At `/speckit.specify`, query parked work (`bd list --status deferred --json`)
  and surface hits before writing the spec.
MUST Pour before writing the spec, after obtaining the explicit choice;
  persist the choice on the new root before advancing to specification work.
  Profiles live in this plugin's `formulas/`; `bd cook <name>`.
  Use `--var agent_assign=no` if that extension is missing.
MUST Validate `autonomous` and `agent_assign` as exactly `yes` or `no` before pouring.

TASK STATE (task-producing commands)
MUST When /speckit.tasks instructs writing specs/*/tasks.md, create beads
  instead: `bd create "T00N <title>" --parent <implement-step-id> --spec-id
  <NNN-slug> -t task`. Bulk `bd create -f <tmp>.md` OUTSIDE specs/.
MUST When a later phase instructs reading tasks.md, query beads:
  `bd query 'spec_id="<NNN-slug>"' --json`.
MUST Keep the implement parent open until every implementation child is closed.

GATES (molecule lifecycle commands)
MUST Resolve a human gate with `bd gate resolve <gate-id>` then `bd close <step-id>`.
MUST Omit routine clarify, analyze, and verification sign-off gates only when
  the recorded choice is `human_approvals=no`; retain them when it is `yes`.
MUST Record review findings and the questions a reviewer would have been asked
  on each preceding step when routine sign-off is omitted.
MUST Run clarification, analysis, independent spec/security/code reviews,
  verification, and tests regardless of the routine approval choice.
NOT Waive consequential safety/provider confirmations or unresolved requirements.
MUST Wait only on gates that are actual dependencies of the selected work.
NOT Treat future-stage or unrelated gates as a repository-wide blockade;
  independent settled implementation, pre-spec, and governance work may continue.
NOT `bd close <gate-id>` to resolve a gate; the `bd-close-gate` extension checks
  literal ids against the database and blocks gate closure.

COMMAND ROUTING (lifecycle commands)
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

PR REVIEW LOOP (PR lifecycle commands)
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

DECISIONS (phase transitions)
MUST Register a hard-to-reverse choice when it lands (`adr` skill / decision bead).
Phases that earn a record: plan, critique/security, analyze, implement, iterate.

SUB-PROCESS MOLECULES (sub-process commands)
MUST Bond, do not pour loose: `bd mol bond mol-speckit-<name> <target-id> --var feature=<NNN-slug>`.
Bond to the STEP that found the work so the first child is ready immediately.

build-formula lives in the beads plugin. Do not duplicate it here.
