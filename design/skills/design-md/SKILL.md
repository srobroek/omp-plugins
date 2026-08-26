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

1. Route to `create-design-md`, which EXTRACTS a DESIGN.md from something that already
   exists rather than authoring one from nothing. It defines exactly two modes, Repository
   mode and URL mode, and its own restriction is the precondition: "If rendered inspection
   is unavailable, ask for screenshots or source files. Do not create a DESIGN.md from copy,
   metadata, or HTML structure alone." -> LOAD it and follow its section order.
2. Establish that precondition BEFORE routing: name the repository path or the public URL
   this run will inspect. -> a real inspectable source is named. With nothing to extract
   from, STOP and say so, then ask the user for the repository, the URL, screenshots, or
   source files. Do NOT author the file by another means: one assembled from copy, metadata,
   or markup structure reads exactly like an extracted one and is not.
3. Check that name is in your available skills BEFORE loading it. Reading a `skill://`
   path that does not exist throws `Unknown skill`. -> present: LOAD and follow. Absent: do
   NOT install it yourself, and do NOT write the artifact yourself. STOP: report the gap,
   name the install command from `skill://design-md/references/upstream.md`, and ASK the
   user to run it. An install applies from the NEXT session, because OMP discovers plugins
   at startup, so never install and retry within this one.
4. Ground every value in the audit, not in invention: run `skill://design-system-audit`
   first and hand the routed skill its `file:line` evidence. -> every `{group.token}`
   reference resolves against a real carrier.
5. Validate the result, passing a path derived from the repository root, never a bare
   filename. -> `npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"`
   exits zero. A bare `DESIGN.md` resolves against the session cwd, so it exits 2 with
   "not found" whenever the cwd is not the directory holding the file.
6. When editing an existing DESIGN.md, gate the change. -> `npx --yes @google/design.md
   diff "<before>" "<after>"` exits zero, meaning the edit added no new error or warning.

## Rules

MUST Treat DESIGN.md as authored intent and rationale, not as the compiler input. The
  canonical machine source is layered DTCG under `tokens/**/*.json`; see
  `skill://design-system-audit/references/token-pipeline.md` for why the export is lossy.
MUST Resolve every `{group.token}` reference. `broken-ref` is error-level and blocks.
MUST Expect more than one error-level failure. An invalid dimension is also error-level,
  measured: `clamp(2.5rem, 7vw, 4.5rem)` exits 1 as "not a valid dimension", carrying no
  rule id. So a clean `broken-ref` count does not mean the file passes.
MUST Put anything undecided under `Known Gaps` with the question left open.
MUST STOP when there is nothing to extract from, or when `create-design-md` is absent.
  It supports Repository mode and URL mode only, and forbids creating the file "from copy,
  metadata, or HTML structure alone". Ask for the repository, the URL, screenshots, or
  source files and wait. A DESIGN.md written from anything else is indistinguishable from
  an extracted one, which is what makes improvising it worse than returning nothing.
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
