# Verify a formula, and diagnose one that will not pour

## Diagnose with cook, never with pour

`bd mol pour` collapses every formula error into one misleading message:

```
$ bd mol pour vbad --dry-run
Error: vbad not found as formula or proto ID

$ bd cook vbad --dry-run
Error: resolving formula: formula validation failed:
  - steps[0] (a): needs references unknown step "nonexistent"
```

The file exists and is readable. In a composed set, one broken fragment poisons **every** consumer with
the same not-found message, so the error names the wrong formula.

**On any `not found as formula or proto ID`, re-run with `bd cook` before believing the file is missing.**

## Never verify with `bd formula show`

It prints only the child's own steps:

```
$ bd formula show ovtop
🌲 Steps (2):

$ bd mol pour ovtop --dry-run
Dry run: would pour 5 issues
```

The published docs recommend `formula show --json` for exactly this purpose. For a composed formula that
advice is wrong.

## The assertion set

Run per supported selection, **including all-options-off** -- the case nobody tests.

| # | Assertion | Catches |
|---|---|---|
| 1 | Step count matches expectation | Wrong condition wiring |
| 2 | Every declared `needs` edge present after pour | A typo'd step id |
| 3 | **Every step with a declared `needs` has ≥1 `blocks` edge** | The anchor violation -- the costliest silent failure |
| 4 | `Gate:` bead count and ids per selection | A lost human approval |
| 5 | Every gate `type` ∈ `human｜timer｜gh:run｜gh:pr` | The orphan-gate stall |
| 6 | A redeclared step still carries its parent's gate and condition | The override trap |
| 7 | Mutually exclusive routes yield exactly one surviving step | An equality-condition error |
| 8 | Exactly one entry point in `bd ready` | A join that lost its sequencing |
| 9 | A `phase = "vapor"` formula warns on `pour`, succeeds on `wisp` | Phase mismatch |
| 10 | No `labels`, `assignee` or `metadata` value contains `{{` after pour | The substitution gap |
| 11 | Validation ran through `bd cook` | A misdiagnosed error |

Assertions 3 and 8 require a **real pour**, not `--dry-run`. A step whose entire `needs` list was
filtered keeps its `parent-child` edge and loses its `blocks` edge, and the dry-run listing renders both
identically. Only `bd show <id>` distinguishes them.

## `scripts/assert-formula.py`

Runs the mechanical assertions for one selection.

```bash
assert-formula.py <formula> [--var k=v ...] [--expect-steps N] [--expect-gates N] [--deep]
```

It cook-validates first, then parses `pour --dry-run` for step and gate counts, checks the gate
vocabulary, and greps for unsubstituted braces. `--deep` pours for real and asserts a single entry point.

Exit 0 on pass, 1 on any failure, with the observed value printed. Wire it into the owning package's test
suite once per supported selection, so a later edit cannot silently drop a gate or an anchor.

## Verify in a throwaway workspace

```bash
mkdir -p /tmp/fcheck/.beads/formulas && cd /tmp/fcheck && git init -q . && bd init
cp <formula>.formula.toml /tmp/fcheck/.beads/formulas/
```

A real pour writes beads. Never assert against a live project database.

## Reading the pour listing

```
  - build-formula (from build-formula)                    <- the ROOT, not a step
  - confirm demo is formula-shaped (from build-formula.shape-check)
  - Gate: human (from build-formula.gate-author-signoff)  <- a gate bead
```

The root is `(from <formula>)` with no dot; every step is `(from <formula>.<step-id>)`; every gate is
`.gate-<step-id>`. Count on the dot, not on the name -- that off-by-one is easy to write and it makes an
expected-count assertion wrong rather than the formula.
