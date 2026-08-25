---
name: speckit-workflow
description: SpecKit beads workflow — molecule per spec, tasks.md never authored, command-time routing.
alwaysApply: true
---

The upstream /speckit.* skills are unmodified; they still talk about tasks.md.
This layer redirects them: state lives in beads, never tasks.md. The poured
molecule is the phase DAG and the only statement of step order.

EXECUTION
MUST Invoke SpecKit commands through their runtime-native skill interface.
NOT Invoke deprecated `/speckit.implement`; route through the agent-assign chain
  (assign -> validate -> execute) and work the molecule steps. `speckit-basic`
  has no such chain: its `implement` step works the task beads under it directly.
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
MUST Pour one molecule per spec dir. Profiles: `speckit-basic` (10),
  `speckit-lean` (18), `speckit-feature` (26). All take `autonomous` and
  `agent_assign`. `bd mol pour <profile> --var feature=<NNN-slug>`, then
  `bd update <root-id> --spec-id <NNN-slug> --metadata '{"spec_dir":"specs/<NNN-slug>"}'`.
DEFAULT Track position with `bd mol current <root-id>`.

SPEC START
MUST At `/speckit.specify`, query parked work (`bd list --status deferred --json`)
  and surface hits before writing the spec.
MUST Pour a molecule before writing the spec. Profiles live in this plugin's
  `formulas/`; `bd cook <name>`. Use `--var autonomous=yes` if no human can
  resolve gates; `--var agent_assign=no` if that extension is missing.

TASK STATE
MUST When /speckit.tasks instructs writing specs/*/tasks.md, create beads
  instead: `bd create "T00N <title>" --parent <implement-step-id> --spec-id
  <NNN-slug> -t task`. Bulk `bd create -f <tmp>.md` OUTSIDE specs/.
MUST When a later phase instructs reading tasks.md, query beads:
  `bd query 'spec_id="<NNN-slug>"' --json`.
MUST Keep the implement parent open until every implementation child is closed.

GATES
MUST Resolve a human gate with `bd gate resolve <gate-id>` then `bd close <step-id>`.
NOT Wait on a human gate in an unattended run — pour `--var autonomous=yes`.
MUST When a gate was skipped that way, record on the preceding step what a
  reviewer would have been asked.
NOT `bd close <gate-id>` to resolve a gate — enforced by `rule://beads-gate-close`.

COMMAND ROUTING (was the dispatcher table)
- constitution / roadmap.write: project-scoped; do not pour a molecule.
- tinyspec: no lifecycle; do not pour. If it grows, stop and pour a feature molecule.
- bugfix.report: active spec → `bd mol bond mol-speckit-bugfix`; no spec → create
  the spec dir first. The patch step's tasks.md write is denied — create beads.
- brownfield.bootstrap: read legacy tasks.md; import once as beads; never write it.
- cleanup / cleanup.run / converge / iterate.apply / reconcile.run / refine.propagate:
  their tasks.md writes are denied. Create children of the implement step instead.
- analyze: run inline (not a subagent); task state from `bd list --spec`.
- review.run / qa.run: bond `mol-speckit-fix-findings` for code defects; converge
  for NEVER-built requirements.
- retro.run: read beads (`bd list --spec --status all --json`), close reasons,
  wisps, and decision beads — not only spec.md/plan.md.

DECISIONS
MUST Register a hard-to-reverse choice when it lands (`adr` skill / decision bead).
Phases that earn a record: plan, critique/security, analyze, implement, iterate.

SUB-PROCESS MOLECULES
MUST Bond, do not pour loose: `bd mol bond mol-speckit-<name> <target-id> --var feature=<NNN-slug>`.
Bond to the STEP that found the work so the first child is ready immediately.

build-formula lives in the beads plugin. Do not duplicate it here.
