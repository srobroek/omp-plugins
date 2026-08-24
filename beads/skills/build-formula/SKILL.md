---
name: build-formula
description: Use when authoring a bd formula, choosing whether work should be a formula at all, or debugging one that pours the wrong DAG.
---

# Build a bd formula

TRIGGER
+ turning a repeatable process into a `bd` formula, reusable or ad hoc
+ "should this be a formula or a skill?"
+ a formula pours the wrong step count, or a step runs before its predecessor
+ adding optional stages, gates, or `extends` to an existing formula
- claiming, closing, commenting, or labelling day-to-day → `beads.context.md`
- disposing of a finished molecule (promote/squash/burn) → `beads.composition.context.md`
- coordinating live agents, wisp grammar, decision records → `beads.orchestration-doctrine.context.md`

## Boundary with steering

This skill owns **authoring a formula**: the step schema, `condition`, gates, composition, and the
assertions that prove a formula pours what it claims. It is loaded when writing one.

Steering owns **operating beads**: the execution-shape table, claiming, the carrier doctrine, wisp TTLs,
and disposition. It is always available and applies whether or not a formula is involved.

Where a fact belongs to both, it lives in steering and this skill names the consequence only. Example:
the carrier doctrine is steering; the authoring consequence is that a step's `notes` is durable, so
chatter belongs on a wisp.

## Is it formula-shaped? Answer first

A formula is a fixed DAG cooked once and instantiated many times. **Steps are decided at cook time.**

| Work | Formula? |
|---|---|
| Fixed stages, some optional per run | yes |
| A branch chosen by a value known before the run | yes -- `condition` |
| Human approval between stages | yes -- gates |
| One unit repeated over a set known at start | yes -- pour per unit |
| Drain-until-empty over a runtime-discovered set | **no** -- step count unknown at cook |
| The next step depends on the previous step's output | **no** -- one step, branch inside it |
| A probe/action decision table | **no** -- that is judgement; write a skill |

Could a human draw the DAG before starting? If it needs a loop with an unknown bound, write a skill
that *pours* formulas instead.

## Workflow

1. **Pour the builder.** `formulas/build-formula.formula.toml` is a formula that builds a formula --
   14 steps, the order that catches mistakes soonest, with the traps in each step's description.

   ```bash
   bd mol pour build-formula --var name=<stem> --var kind=reusable
   bd mol wisp build-formula --var name=<stem> --var kind=adhoc   # throwaway
   ```

   Selection vars: `has_optional_steps`, `has_gates`, `has_external_gate`, `is_composed`,
   `ships_in_package`. All default sensibly; an unflagged pour gives the reusable-with-gates path.

2. **Work the molecule.** Each step names its own traps. `shape-check`, `anchor-audit`,
   `gate-runner`, `cook-validate` and `verify-selections` are `priority = 1` -- they are where formulas
   go wrong.

3. **LOAD a reference only when its step comes up** -- see the table below.

4. **Verify before shipping.** Assert every selection against `bd mol pour --dry-run`, including
   all-options-off. `scripts/assert-formula.py` runs the mechanical ones.

## Reference → when

| Load | When |
|---|---|
| `references/authoring.md` | Writing steps, vars, labels, metadata, priority, notes |
| `references/conditions.md` | Any optional or mutually-exclusive stage. **Includes the anchor rule** |
| `references/gates.md` | Human approval, or waiting on CI, a PR, or a timer |
| `references/composition.md` | `extends`, fragments, overriding an inherited step |
| `references/verify.md` | The assertion set, and diagnosing a formula that will not pour |

## Rules

MUST Every step's `needs` contains at least one **unconditional** step. A step whose entire `needs`
  list is filtered out loses all sequencing, keeps only a `parent-child` edge, and becomes immediately
  ready -- with no error at pour. This is the costliest silent failure in the system.

MUST Diagnose with `bd cook`, never `bd mol pour`. Pour reports every formula error as
  `not found as formula or proto ID`, naming a file that exists.

MUST Verify a composed formula with `bd mol pour --dry-run`. `bd formula show` prints only the child's
  own steps -- `Steps (1)` for a formula that pours 4 beads.

MUST Name what will run `bd gate check` before declaring a `timer`, `gh:run` or `gh:pr` gate. There is
  no daemon; an unrun gate stalls the molecule forever.

MUST Use distinct step ids plus `condition` for mutually exclusive routes. Overriding one step in a
  child **drops its gate and its condition** silently.

MUST Validate every var in the skill or in prose. `pattern` and `enum` are parsed and never enforced;
  only `required` is, and only at pour.

NOT `{{var}}` in `labels`, `assignee` or `metadata` -- substitution reaches `title`, `description` and
  `notes` only. Elsewhere the braces are stored literally.

NOT `optional = true` on a step. Unknown top-level keys are dropped at cook and the step is created
  anyway. Use `condition`.

NOT Gate type `bead`. Multi-rig routing was removed; it can never close.

NOT A formula for work whose step count depends on the run.

DEFAULT Name the file for the reference you emit -- bd resolves by **filename stem**, not by the
  `formula` key inside the file.

DEFAULT Persistent per-step information goes in `notes`; ephemeral coordination goes on a wisp.

## Output

A `.formula.toml` whose every supported selection has been poured with `--dry-run` and asserted.
State which selections you verified and the step and gate count of each.
