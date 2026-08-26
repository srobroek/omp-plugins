---
name: design-md
description: Authors and validates repo-root DESIGN.md as the authored design intent artifact. Triggers on write a DESIGN.md or document the design system.
---

# DESIGN.md

Phase SPECIFY. Record durable visual decisions and their rationale in one linted artifact.

TRIGGER
+ "write a DESIGN.md", "document the design system", "record these design decisions"
+ a design decision was just made that a later session must not relitigate
- discovering what the system already is -> `design-system-audit`
- the machine-readable token source -> `skill://design-system-audit/references/token-pipeline.md`
- judging an implemented surface -> `ui-review`

## Workflow

1. Route to `create-design-md` for authoring. -> LOAD it and follow its section order.
2. Check that name is in your available skills BEFORE loading it. Reading a `skill://`
   path that does not exist throws `Unknown skill`. -> present: LOAD and follow. Absent:
   STOP, emit the install command from `skill://design-md/references/upstream.md`, and
   run it.
3. Ground every value in the audit, not in invention: run `skill://design-system-audit`
   first and cite its `file:line` evidence. -> every `{group.token}` reference resolves
   against a real carrier.
4. Validate the result. -> `npx @google/design.md lint DESIGN.md` exits zero; errors block,
   warnings are reported.
5. When editing an existing DESIGN.md, gate the change. -> `npx @google/design.md diff
   before after` exits zero, meaning the edit added no new error or warning.

## Rules

MUST Treat DESIGN.md as authored intent and rationale, not as the compiler input. The
  canonical machine source is layered DTCG under `tokens/**/*.json`; see
  `skill://design-system-audit/references/token-pipeline.md` for why the export is lossy.
MUST Resolve every `{group.token}` reference. An unresolved ref is the linter's only
  error-level rule, `broken-ref`.
MUST Put anything undecided under `Known Gaps` with the question left open.
DEFAULT Cite the audit's `file:line` beside any value the reader cannot trace to a carrier.
NOT Leave `TODO` or `TO_FILL` in the file. An unfilled placeholder is worse than an
  acknowledged gap, because it reads as done.
NOT Route to `impeccable document` for this. Its own site says six sections while its
  repository prompt says eight, and its illustrative frontmatter fails the current
  linter: the dimension pattern rejects `clamp(...)`, and its sample token ref is unresolved.
NOT Trust the linter's `contrast-ratio` rule as a contrast gate. It warns only below
  4.5:1 and only on component `backgroundColor` and `textColor` pairs, with no 3:1
  UI-boundary rule and no theme matrix.

OUTPUT
L1 DESIGN.md: written | updated -- sections touched.
   Lint -- the `lint` result, and the `diff` result on an edit.
   Gaps -- `Known Gaps` entries added.
CAP 120w
