---
name: toolchain-pragmatic
description: When producing code, comments, or written artifacts — economy, no in-artifact justification, comment discipline.
globs: ["**/*"]
---

# Pragmatic Working Style

What the agent PRODUCES: code, comments, and written artifacts.

Written artifacts (docs, READMEs, specs, decision records, comments, PR and commit
text): write for the released, steady-state artifact, not the current moment or its
history.

No justification in a produced artifact:
- Never write the reason for a choice into code, a comment, a docstring, markdown,
  or any prose the artifact ships with. The artifact states what IS.
- Three exceptions, and only these: the reader cannot recover the reason from the
  code or text itself (a constraint, an invariant, a non-obvious gotcha, a
  measured number that decided a threshold); the genre exists to record a decision
  (ADR, spec, commit message, PR body); or the user asked for the rationale.
- A rejected alternative, a defence of the approach, a note on what was tried
  first, or a comparison to what it replaces belongs in the commit message, never
  in the artifact.
- Reassurance nobody asked for ("no configuration required", "this is safe",
  "simple and clean") is justification wearing a different hat. Cut it.

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
