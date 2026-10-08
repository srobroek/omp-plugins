---
name: design-md
description: Routes DESIGN.md extraction to the vendored create-design-md and lints the result. Triggers on write a DESIGN.md or document the design system.
---

# DESIGN.md

Phase SPECIFY. Route the extraction of durable visual decisions into one linted artifact.
This skill does not author the file: the routed upstream extracts it, and this skill gates
the result.

TRIGGER
+ "write a DESIGN.md", "document the design system", "record these design decisions"
+ a design decision was just made that a later session must not relitigate
- discovering what the system already is -> `design-system-audit`
- the machine-readable token source -> `skill://design-system-audit/references/token-pipeline.md`
- judging an implemented surface -> `ui-review`

## Workflow

1. Establish the precondition first: name the repository path or the public URL this run
   will inspect. -> a real inspectable source is named. With nothing to extract from, STOP
   and say so, then ask for the repository, the URL, screenshots, or source files. The
   routed `create-design-md` EXTRACTS a DESIGN.md from something that already exists. It
   defines exactly two modes, Repository mode and URL mode, and its own restriction reads:
   "If rendered inspection is unavailable, ask for screenshots or source files. Do not
   create a DESIGN.md from copy, metadata, or HTML structure alone."
2. Read `skill://design-md/references/create-design-md.md`, vendored from
   `ibelick/ui-skills`. -> its two modes and section order are loaded.
3. Ground every value in the audit, not in invention: run `skill://design-system-audit`
   and hand the routed skill its `file:line` evidence. -> every `{group.token}` reference
   resolves against a real carrier.
4. Follow `create-design-md`'s section order on the named source. -> a DESIGN.md
   extracted from that source, with undecided items under `Known Gaps`. Its own lint step
   passes a bare `DESIGN.md`; replace that with the root-derived path in step 5.
5. Validate the result, passing a path derived from the repository root, never a bare
   filename. -> `npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"`
   exits zero. A bare `DESIGN.md` resolves against the session cwd, so it exits 2 with
   "not found" whenever the cwd is not the directory holding the file.
6. When editing an existing DESIGN.md, gate the change. -> `npx --yes @google/design.md
   diff "<before>" "<after>"` exits zero, meaning the edit added no new error or warning.

Upstream provenance, the linter's full rule list, and its measured limits:
`skill://design-md/references/upstream.md`.

## Rules

MUST Treat DESIGN.md as authored intent and rationale, not as the compiler input. The
  machine source is the project's token carrier, which for a new pipeline is layered DTCG
  under `tokens/`; see `skill://design-system-audit/references/token-pipeline.md` for why
  the export is lossy.
MUST Resolve every `{group.token}` reference. `broken-ref` is error-level and blocks.
MUST Expect more than one error-level failure. An invalid dimension is also error-level,
  measured: `clamp(2.5rem, 7vw, 4.5rem)` exits 1 as "not a valid dimension", carrying no
  rule id. So a clean `broken-ref` count does not mean the file passes.
MUST Put anything undecided under `Known Gaps` with the question left open.
MUST STOP when there is nothing to extract from. Ask for the repository, the URL,
  screenshots, or source files and wait.
  A DESIGN.md written from anything else is indistinguishable from an extracted one,
  which is what makes improvising it worse than returning nothing.
DEFAULT Cite the audit's `file:line` beside any value the reader cannot trace to a carrier.
NOT Leave `TODO` or `TO_FILL` in the file. An unfilled placeholder is worse than an
  acknowledged gap, because it reads as done.
NOT Route to `impeccable document` for this. Its Seed mode authors a DESIGN.md for a
  project with no implementation, and its prompt asks for a creative north star and mood
  language, which the extract-only precondition forbids. Its sample frontmatter also fails
  the current linter, measured at 0.4.0: `clamp(...)` and `letterSpacing: normal` are
  invalid dimensions, and `{colors.primary-deep}` is a broken ref. It never runs the linter.
NOT Trust the linter's `contrast-ratio` rule as a contrast gate. It warns only below
  4.5:1 and only on component `backgroundColor` and `textColor` pairs, with no 3:1
  UI-boundary rule and no theme matrix.

OUTPUT
L1 DESIGN.md: written | updated -- sections touched, plus the route that extracted it.
   Lint -- the `lint` result, and the `diff` result on an edit.
   Gaps -- `Known Gaps` entries added.
CAP 120w
