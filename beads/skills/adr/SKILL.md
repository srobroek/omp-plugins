---
name: adr
description: Register an architecture decision as a beads decision bead. Use when a hard-to-reverse choice is made, when superseding one, or when `bd lint` reports findings.
---

# Architecture decision records

Records a decision when it is made, as a beads `decision` bead. The bead is
the record. The file under `docs/adr/` is generated from it by a pre-commit hook,
so anyone without beads installed can still read the decision in a PR.

Requires `bd`. Without it the hook exits 0 and the committed files stand.

## When to use

- A choice is hard to reverse, constrains later work, or crosses a package,
  contract, or agent boundary.
- A decision is being replaced, which is a supersede rather than an edit.
- `bd lint` reports a decision bead missing a section.
- Someone asks "why is it built this way", and the answer is not written down.

Do not use for a choice a later commit can undo at no cost, or a naming preference.

## Registering, while the work happens

```bash
# Create it before the choice affects anything else. --validate rejects a
# description missing a required section, so the gate runs at creation.
bd create "Adopt X for Y" --type decision --id adr-7 --force --validate \
  --spec-id 042-some-spec \
  -d '## Decision
Adopt X.

## Rationale
X is the only option that satisfies <driver>, verified by <evidence>.

## Alternatives Considered
Y, rejected because <cost>. Z, rejected because <cost>.'

bd update adr-7 --claim              # while drafting: claimed, so others skip it
bd defer adr-7 --reason "proposed"   # undecided: out of bd ready, still in bd list
bd close adr-7 --reason accepted     # decided: the hook renders it on next commit
```

`--id adr-N --force` keeps decisions out of the work id space. `--force` is
required because the id prefix differs from the database's; it is not overriding a
safety check.

Link the work without blocking it:

```bash
bd dep add <affected-bead> adr-7 --type relates-to
bd dep add <validator-bead> adr-7 --type validates
```

## Why a decision is not open work

Every discovery path is `bd ready`, so an undecided decision must stay out of it
without being closed. `bd defer` with no `--until` is indefinite and
status-based -- nothing wakes it on a timer, and `bd list` still shows it.

Do not build a sentinel task or a blocking epic for this. A `decision` bead cannot
be blocked by an epic, and an epic blocker that beads does accept is silently
ignored by `bd ready`.

A closed bead stays fully editable, so closing costs nothing: notes and comments
still apply afterward.

## Writing the description

`bd create --validate` and `bd lint` enforce these sections:

1. **`## Decision`** -- the choice, stated in one unhedged sentence.
2. **`## Rationale`** -- the driver that settled it and the evidence, written
   against criteria chosen before the winner was known.
3. **`## Alternatives Considered`** -- every option genuinely weighed, and why each
   lost. A straw option added to flatter the winner makes the record worthless.

`## Consequences` and `## Confirmation` are optional to the tool and expected by
review. State a consequence that is a **cost**: a record with no downside was not a
decision between real alternatives. No tool enforces that one.

Notes hold the running narrative and can be corrected wholesale while the
decision is proposed; comments are the attributed audit trail. Do not put one MADR
section per note -- notes only append, so a correction loses the boundary.

## Superseding

```bash
bd supersede adr-7 --with adr-12
```

This closes `adr-7` with a reference to its replacement and records a typed
`supersedes` edge, which the renderer reads to mark the old file `superseded`.
Never hand-maintain a metadata field for this: a field and an edge disagreeing is
how a file came to claim a decision still stood after it had been replaced.

Supersede when the **decision** changes. Shipping a release that implements an
existing decision changes nothing about the record -- an ADR is point-in-time, and
re-superseding it per release destroys that.

## The generated file

| Property | Value |
|---|---|
| Format | MADR 4.0.0 |
| Path | `docs/adr/NNNN-kebab-title.md` |
| Numbering | creation order among closed decisions, not the bead id |
| Source | `bd export`, filtered to `issue_type == "decision"` |
| Rendered | closed decisions only |

Never edit a file under `docs/adr/`. It is regenerated from its bead on the next
commit and the edit is destroyed. Edit the bead.

OMP injects this via the `beads-adr-generated-guard` TTSR rule (advisory,
not abort): the file is regenerated from the bead. Hand-authored ADRs stay
editable.

## Installing the hook

```bash
prek install --git-dir .git
```

`--git-dir` is required wherever `core.hooksPath` points outside the repository, as
a corporate secret scanner does. Bare `prek install` refuses there and suggests
unsetting `core.hooksPath`, which would disable the scanner; both layers coexist
with the shim in place.

The `repos:` fragment is at `templates/pre-commit-adr.yaml`. project-setup merges
it into `.pre-commit-config.yaml` and vendors `render_adrs.py` into the repository,
rewriting `entry:` to the vendored path.

Pre-commit rather than CI: the bead lives in the local Dolt store and is not pushed
yet, `refs/dolt/data` is versioned independently of git commits so CI cannot pin
the database to the commit under test, and the beads doctrine forbids `bd dolt
pull` from any lifecycle hook. Reading the local store needs no sync authority.
