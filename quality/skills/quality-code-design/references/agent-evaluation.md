# Evaluating code-agent guidance

Read when changing coding/review instructions, model routing, or tools, or investigating a behavioral regression. Keep the initial suite small and expand it from actual failure modes. This evaluates the agent plus its instructions and execution environment; it is not a compliance certificate.

## Repeatable comparisons

1. Record baseline and candidate revisions, resolved model/configuration, tools, source fixture, and the accepted outcome. Change one relevant variable when diagnosing an effect.
2. Select representative cases from `skill://quality-code-design/assets/evaluation-cases.json` and add task-local cases from real failures. The case bank is development material, not held-out evidence. Keep fresh cases unavailable during prompt tuning when testing generalization.
3. Give each executor only its task, raw fixture/evidence, authorized tools, and candidate guidance. Keep `skill://quality-code-design/assets/evaluation-rubric.json`, prior answers, diagnoses, and grader notes out of its context. Use isolated disposable workspaces; do not run evaluations against production effects.
4. Inspect the resulting code/environment and recorded actions. Run relevant executable acceptance checks where fixtures support them. Scenario plans test reasoning and instruction following only; they do not prove runtime behavior, package loading, or delegation coverage.
5. Grade correctness, contract preservation, reuse research before code writes, unnecessary complexity, evidence quality, and role/scope adherence. For reviewers, include both known-defect and clean cases; measure misses and unsupported findings. Compare outcomes with the baseline, alongside elapsed time, review effort, and cost when recorded.
6. Repeat unstable cases; distinguish regression, improvement, equivalent behavior, and insufficient evidence. Calibrate subjective graders against independently reviewed examples. Turn confirmed failures into regression cases, retaining previously passing cases when expanding capabilities.
7. Report configuration, case IDs, trials, observed results, unresolved uncertainty, and the smallest justified instruction change. Keep required repository checks. If live execution is unavailable, label the result a scenario/static review and state what remains untested.

## Good and bad evaluation

**Do:** grade the artifact and observable state against independent acceptance. Inspect failures for grader mistakes and valid alternative solutions.
**Do not:** reward an agent for claiming compliance, pass it the intended answer, or require one exact implementation shape when several honor the contract.

Bad: show a reviewer the suspected bug and count its repetition as independent detection.
Good: supply only the authorized diff/context, then compare anchored findings against an independently maintained rubric.

Bad: score reuse by whether a response says "researched libraries."
Good: inspect the pre-write sequence, repository paths/symbols, authoritative sources/versions, and the suitability decision. Check that the final code uses the chosen capability or substantiates the remaining custom scope.

Bad: a steering update adds interfaces to every script, but passes because tests remain green.
Good: include proportionality cases, grade unnecessary structure and maintenance burden, and compare the working result with the simpler baseline.

**Exception:** deterministic checks cannot settle every design tradeoff. Use a concrete rubric and calibrated human/model judgment, permit UNKNOWN for missing evidence, and preserve valid alternate solutions. Do not build a general evaluation platform to run a handful of cases.

## Interpretation

Use task success, rework, review precision/recall, maintainability under follow-up change, and resource cost together. Avoid universal speed or quality claims from different populations and outcome measures. An instruction update that passes a few cases is evidence for those cases only.

- [Anthropic agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) distinguishes final-state outcomes, deterministic/subjective grading, capability tests, and regressions. This is practitioner guidance.
- [METR's February 2026 update](https://metr.org/blog/2026-02-24-uplift-update/) describes selection and measurement problems in newer productivity estimates. Do not present its early-2025 slowdown as a current universal effect.
- [Cui et al.'s field experiments](https://doi.org/10.1287/mnsc.2025.00535) measure completed tasks with a code-completion assistant; that result does not establish autonomous-agent maintainability.
- [Borg et al.'s maintainability study](https://link.springer.com/article/10.1007/s10664-026-10889-1) found no significant downstream difference in its studied tasks, conducted in late 2024. A null result does not prove equivalence across current agent workflows.

Keep advisor delivery/precision sampling in `skill://advisor-resample`; use this guide for coding and review task outcomes rather than repurposing that census.
