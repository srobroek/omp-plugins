# Code-design evaluation cases

Development fixtures for checking how agents follow `rule://quality-code-design` and
`skill://quality-code-design`. They live outside the installed skill directory so an
executor under test cannot read the grading rubric through a `skill://` URI.

- `evaluation-cases.json`: task prompts, each with an IMPLEMENT or REVIEW mode.
- `evaluation-rubric.json`: per-case pass criteria plus the common grading rules.

Run comparisons with the owner's `tune-model-prompt` method: noise floor first, held-out
cases kept unscored until the candidate is frozen, effect-based verdicts. For these cases:

- Give each executor only its task, the fixture, its authorized tools, and the candidate
  guidance. Keep the rubric, prior answers, and grader notes out of its context.
- Grade the artifact and observable state against the rubric, not the agent's claims of
  compliance. Accept valid alternative designs.
- These cases are development material, not a held-out benchmark. A plan-only run is a
  scenario review: it proves no runtime behavior, package loading, or delegation coverage.
