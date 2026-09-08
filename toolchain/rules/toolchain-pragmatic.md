---
name: toolchain-pragmatic
description: When producing code, comments, or written artifacts — economy, no in-artifact justification, comment discipline.
---

# Pragmatic Working Style

What the agent PRODUCES: code, comments, and written artifacts.

Written artifacts (docs, READMEs, specs, decision records, comments, PR and commit
text): write for the released, steady-state artifact, not the current moment or its
history.

Shipped prose states the steady-state contract. Put decision rationale and
rejected alternatives in an ADR/decision bead or the requested report, not in
implementation prose. Keep non-obvious constraints, invariants, and gotchas
where readers need them. Include rationale when the user explicitly requests it.
Cut unsolicited reassurance.

Code economy -- in order of preference: existing code, config, or a deletion; the
standard library; a popular, maintained, light library (never a heavyweight for
one function); the smallest hand-rolled implementation that solves the actual
problem.

- Price a hand-roll by its full life -- edge cases, tests, future debugging -- not
  its line count; if that exceeds one maintained dependency, take the dependency.
  A fewer-dependencies preference never outranks stated functional requirements.
- Extend an existing function that covers most of the need instead of adding a
  near-duplicate. Logic needed twice: extract a shared function -- never copy.
- YAGNI: build for the requirement in front of you, not predicted growth; add the
  abstraction when the second consumer exists. No wrappers around wrappers, no
  drive-by refactors. Smallest diff that solves the problem; prefer deleting code.
- Exception to no-drive-bys: fix a pre-existing issue you encounter in your
  work when the fix is straightforward, even though you did not cause it. Keep
  it an incidental, in-scope improvement; report anything non-trivial instead
  of expanding the task around it.

Code comments:
- Allowed, but the minimum needed to explain the code. Prefer the docstring
  (pydoc, JSDoc, doc comment) over inline comments; that is where API intent,
  params, and contracts belong.
- Explain a why, constraint, invariant, or gotcha the code cannot show -- not a
  restatement of what the code does, and not a defence of why it is written this
  way.
- No broad prose, narrated steps, or banners. A stale comment is worse than none.

Testing:
- NOT Add unit tests for configuration, prose or text files, declarative
  manifests, simple scripts, or trivial behavior whose failure is exposed by a
  parser, linter, syntax check, render, or smoke run.
- MUST Verify those artifacts with the narrowest applicable parser, linter,
  syntax check, render, or smoke command.
- MUST Add unit tests only for executable application or library logic when the
  test protects meaningful observable behavior, a boundary, an invariant, a
  transition, precedence, or a real error.
- DEFAULT Exercise scripts through their real command surface. Unit-test a
  script only when it contains reusable decision logic that a smoke run cannot
  localize.
- NOT Add a test solely for coverage, changed-line count, field forwarding,
  copied defaults, wiring, or the claim that a change has tests.
