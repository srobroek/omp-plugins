# Composition -- extends, fragments, and four traps

```toml
extends = ["parent-formula", "another-parent"]
```

A **list**. A bare string fails. Override-by-id replaces a step wholesale.

## The four traps

### 1. A child cannot delete a parent step

`extends = ["base"]` where `base` declares an `analyze` step, with the child redeclaring only
`implement`, still cooks `analyze: [from: base@steps[2]]`. Override **replaces**; there is no remove.

Therefore a baseline must be a **true minimum** and everything else additive. Absence is expressed by
omitting a fragment from `extends`, never by disabling a step. Shipping a superset and subtracting from it
is impossible.

### 2. Override drops `[steps.gate]` and `condition`

Redeclaring a gated step without repeating its gate block deletes the gate with no warning. Redeclaring a
conditional step drops the condition, forcing the step in permanently.

Since a composing formula typically redeclares many inherited steps to rewire joins, **every redeclared
step must repeat any gate and condition its parent had**. This is the highest-risk operation in a
composed design.

### 3. Diamond composition fails

```
$ bd cook diamond
Error: steps[4]: duplicate id "specify" (first defined at steps[0])
```

`extends = ["a", "b"]` where both `a` and `b` extend a common base. So **fragments must not extend the
baseline** -- keep them flat.

### 4. A fragment referencing a parent step fails standalone

```
Error: steps[0] (x): needs references unknown step "specify"
```

Fragments are flat and **needs-free**; the composing formula owns every join edge.

## The shape that works

| Layer | Contains |
|---|---|
| Baseline | The mandatory spine, plus author-known optional stages guarded by `condition` |
| Fragments | Flat, needs-free step sets, one per pluggable unit |
| Top formula | `extends = [baseline, ...selected fragments]`, and owns **every** join edge by redeclaring it |

Edges are rewired by **redeclaration at generation time**, not by a bond call. When a stage is absent the
top formula names only the surviving predecessors -- and must still satisfy the anchor rule.

## Bond is not a layering mechanism

`bd mol bond` **does** resolve formula names, but only with a `mol-` filename prefix:

```
$ bd mol bond pbase pfrag --dry-run
Error: 'pbase' not found (not an issue ID or formula name)

$ bd mol bond mol-pbase mol-pfrag --dry-run
  A: mol-pbase (formula → will cook as proto)
  Result: compound proto
```

The prefix requirement is undocumented. But bond joins **root-to-root** as a sibling subtree and cannot
rewire an inherited step's `needs`, so it does not give step-level splicing. `--attach` takes issue and
proto IDs only -- never formula names, prefix or not.

Reach for bond when you want two independent graphs to run under one root, not when you want to weave
steps into an existing sequence.

## Verify with pour, never with show

`bd formula show` prints **only the child's own steps**:

```
$ bd formula show ovtop
🌲 Steps (2):

$ bd mol pour ovtop --dry-run
Dry run: would pour 5 issues
```

The docs recommend `formula show --json` to check what the parser understood; for a composed formula that
advice is wrong. Always verify with `bd mol pour --dry-run`.

## Diagnose with cook

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

**On any `not found as formula or proto ID`, re-run with `bd cook` before believing it.**

## `bd mol distill` is not a migration path

`bd mol distill <epic> <name>` extracts a draft formula from a hand-built epic, and it is the cheapest way
to start. But it **drops `metadata`, `notes`, `assignee`, `gate` and `condition`** -- 5 of 8 step fields --
and re-slugifies step ids.

Treat its output as a first draft of the DAG shape and re-add every field by hand. Never use it to
round-trip an existing formula.
