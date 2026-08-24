---
name: beads-adr
description: Recording an architecture decision as a decision bead, and when a choice is hard-to-reverse enough to need one.
globs: ["**/.beads/**"]
---

# Architecture decision records

A decision is registered when it is made, not when the work finishes. The beads
`decision` bead IS the record; the file under `docs/adr/` is a generated
projection of it, written by a pre-commit hook. Reconstructing decisions at
closeout loses the alternatives that were considered and the reason the losing
option lost, which is the part worth keeping.

WHEN A CHOICE EARNS A RECORD
MUST Record a choice that is hard to reverse, constrains later work, or crosses a
  package, contract, or agent boundary.
MUST Record the choice that was REJECTED and why, alongside the one taken. A
  record naming a rejected alternative is what makes it a decision; `bd lint`
  enforces the section.
NOT Record a choice a later commit can undo at no cost, a naming preference, or a
  step already fixed by an existing record.
DEFAULT When in doubt, write the bead. Closing a bead into an ADR is cheap;
  recovering an unrecorded decision is not.

THE BEAD IS THE RECORD
| Property | Value |
|---|---|
| Type | `decision` (aliases `dec`, `adr`) |
| Id prefix | `adr-<n>` via `--id adr-<n> --force`, keeping ADRs out of the work id space |
| Gate | `bd lint --type decision --status all`, exit 1 on a missing section |
| Spec link | `--spec-id <spec>`, a native field |
| Supersession | `bd supersede <old> --with <new>`, a native typed edge |

MUST Write the description with `## Decision`, `## Rationale`, and
  `## Alternatives Considered`. `bd create --validate` rejects a decision missing
  any of them, and `bd lint` catches one already created.
MUST Create the bead BEFORE the choice affects a second bead, agent, or package.
  The carrier doctrine's `decision_key`, `decision_owner`, and `design` fields
  still apply for cross-boundary decisions.
MUST Link affected work with `relates-to` and evidence-supplying work with
  `validates`. Both are non-blocking; `blocks` is never correct for accepted
  policy.
NOT A metadata key for supersession. `bd supersede` records the edge on the old
  bead and closes it with a reference to the replacement; a hand-maintained field
  is what let a file and its bead disagree about whether a decision still stood.

LIFECYCLE, AND WHY A DECISION IS NOT A TASK
| ADR state | Bead | In `bd ready`? |
|---|---|---|
| being drafted now | `open`, claimed | yes -- someone is working on it |
| proposed, undecided | `bd defer <id> --reason ...` | no |
| decided and written | `closed` | no |

MUST Defer a proposed decision rather than leaving it open. With no `--until` the
  defer is indefinite and status-based, so nothing wakes it up on a timer, and it
  stays visible in `bd list` while staying out of every discovery path.
MUST Close the bead once the decision is made. A written decision is not open
  work, and a closed bead stays fully editable -- notes and comments still apply.
NOT An open sentinel task or a blocking epic to hide a decision from the queue. A
  `decision` bead cannot be blocked by an epic at all, and an epic blocker that
  beads DOES accept is silently ignored by `bd ready`.
DEFAULT Claim the bead while drafting, so `--unassigned` filters it from every
  other actor.

NOTES VERSUS COMMENTS
| | `bd note` | `bd comment` |
|---|---|---|
| Shape | one string field, appends | append-only rows |
| Attribution | none | author and timestamp per row |
| Corrigible | yes, `--notes` replaces wholesale | rows are immutable |

DEFAULT Notes carry the running narrative and get corrected while the decision is
  proposed. Comments are the audit trail of what changed and when.
NOT One note per MADR section. Notes only append, so correcting one section means
  rewriting the whole field and losing the boundary; the description holds the
  sections.

THE GENERATED FILE
| Property | Value |
|---|---|
| Format | MADR 4.0.0 |
| Path | `docs/adr/NNNN-kebab-title.md` |
| Numbering | creation order among closed decisions, not the bead id |
| Written by | the `render-adrs` pre-commit hook, from `bd export` |

NOT Edit a file under `docs/adr/`. It is regenerated from its bead on the next
  commit and the edit is destroyed. Edit the bead. A `PreToolUse` guard denies the
  write and names the bead, because a banner inside a file cannot prevent the edit
  it warns about -- the agent has already decided to write by the time it reads
  one.
NOT A CI job that renders from `bd dolt pull`. `refs/dolt/data` is versioned
  independently of git commits, so it is not pinned to the commit under test, and
  the beads doctrine forbids sync from any lifecycle hook.
DEFAULT Absent `bd`, the hook exits 0 and the committed files stand. They were
  correct when committed, because whoever committed them had the database.

WHAT BELONGS IN EACH SECTION
| Section | Holds | Fails when |
|---|---|---|
| Decision | The choice, in one sentence | It hedges |
| Rationale | The driver that settled it, and the evidence | The criteria appear only after the winner |
| Alternatives Considered | Every option genuinely weighed, and why each lost | A straw option is listed to justify the winner |
| Consequences | What becomes harder, not only easier | Only benefits are listed |
| Confirmation | The observable check that verifies compliance | It names no check |

MUST State a consequence that is a cost. A record with no downside was not a
  decision between real alternatives. No tool enforces this; it is review work.

RELATIONSHIP TO OTHER RECORDS
| Record | Scope | Mutability |
|---|---|---|
| `decision` bead | The record, cross-boundary | Editable; supersede rather than reverse |
| `docs/adr/*.md` | Generated projection, for readers without beads | Regenerated; never hand-edited |
| Roadmap | Forward-looking, re-sequenced as plans change | Continuously updated |
| Work-bead comment | Affects only that bead and its owned scope | Local, stays with the bead |

MUST Supersede when the DECISION changes. Shipping a release that implements an
  existing decision changes nothing about the record: an ADR is point-in-time,
  and re-superseding it per release destroys that.
