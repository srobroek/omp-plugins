# Conditional steps and the anchor rule

`condition` is **undocumented** -- zero hits across the published docs -- and fully functional on
bd 1.1.0. The parser leaks its own grammar:

```
Error: filtering steps by condition: step "critique": invalid step condition format:
  "want_critique" (expected {{var}} or {{var}} == value)
```

Its existence is easy to miss because unknown top-level step keys are silently dropped at cook, so
`optional = true` looks like the same class of thing. It is not: `optional` is inert, `condition` works.

## The two forms

```toml
[vars.want_review]
default = "false"

# Truthy — the step exists only when the var is true.
[[steps]]
id = "review"
needs = ["build"]
condition = "{{want_review}}"

# Equality — mutually exclusive routes, one declaration each, DISTINCT ids.
[[steps]]
id = "deploy-staging"
needs = ["approve"]
condition = "{{target}} == staging"

[[steps]]
id = "deploy-prod"
needs = ["approve"]
condition = "{{target}} == production"
```

| Property | Behaviour |
|---|---|
| Truthy set | `true` `True` `TRUE` `1` `yes` `on` include; `false` `0` `no` `off` `""` exclude |
| Default off | `default = "false"` makes an unflagged pour the baseline |
| Undeclared vars | Work via `--var`; an unset var evaluates false |
| Inheritance | A conditional step in a parent is filtered when a child is poured |
| Gate suppression | A filtered gated step contributes neither the step nor its `Gate:` bead |
| Visibility | Survives to `bd formula show --json`, so it is CI-assertable |
| Override | Redeclaring a conditional step **drops the condition**, forcing the step in permanently |

## The anchor rule

**A step whose entire `needs` list is filtered out silently loses all sequencing.** Dropped, not
rewired. With `analyze needs = ["critique"]` and `critique` off:

```
$ bd ready
○ analyze      ← immediately ready, parallel with the first step
○ checklist
```

The bead kept a `parent-child` edge and no `blocks` edge. The pour reported no error. A step ran before
the work it was meant to follow.

### The rule

**Every step's `needs` must name at least one unconditional step.** With
`needs = ["checklist", "critique"]` and `critique` off:

```
DEPENDS ON
  → ○ bdverify-mol-gay: checklist ● P2
```

Two patterns satisfy it:

| Pattern | Shape |
|---|---|
| Anchor on the last mandatory step | Optional stages hang off it; the next mandatory step names the anchor **plus** every optional stage |
| Insert a mandatory no-op join | Explicit, and keeps a long optional chain readable |

Verified at scale: a 20-step formula with 10 conditions poured 13 steps / 2 gates at baseline and 22
steps / 3 gates fully selected, every join retaining a real edge, one entry point in `bd ready`.

### Worked example

```toml
[[steps]]
id = "build"
title = "build"
type = "task"

[[steps]]
id = "security"
title = "security scan"
type = "task"
needs = ["build"]
condition = "{{want_security}}"
labels = ["scan", "scan:security"]

[[steps]]
id = "perf"
title = "perf scan"
type = "task"
needs = ["build"]
condition = "{{want_perf}}"
labels = ["scan", "scan:perf"]

# THE ANCHOR. `build` is unconditional, so all-scans-off still sequences report
# after build rather than making it immediately ready.
[[steps]]
id = "report"
title = "report"
type = "task"
needs = ["build", "security", "perf"]
```

Drop `build` from `report`'s `needs` and the all-off selection silently runs `report` first.

## Where `condition` does not reach

`condition` handles optional stages **the formula's author knows about**. A static formula must
pre-declare every optional step, and every join must name every optional predecessor up front.

A stage that did not exist when the formula was written needs a child formula that **redeclares the
join** -- which drops that step's gate and condition. So:

| Situation | Approach |
|---|---|
| Fixed, author-owned optional set | One static formula, `condition` per stage |
| Third-party or plugin-provided stages | Generate a formula per run with computed joins |
| Both | Static baseline plus a generated child adding only discovered stages |

Generating is not the default -- it adds a file lifecycle, a naming contract, and a gitignore question.
Reach for it when the set is genuinely open.

## Assertions

| Assert | Catches |
|---|---|
| Every step with a declared `needs` has ≥1 `blocks` edge after pour, for **every** selection | The anchor violation |
| The all-options-off selection is a fully sequenced DAG | The case nobody tests |
| Mutually exclusive routes yield exactly one surviving step | An equality-condition error |
| Turning a condition off removes the step's `Gate:` bead too, and on restores both | Gate/condition coupling |
| No shipped conditional step is redeclared by any child | The override trap |

Read the poured beads, not the formula.
