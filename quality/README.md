# quality

Portable code-design steering, adversarial challenge, WATCHDOG advisor-file authoring, and advisor note resampling.

## Code design policy

Enable `quality` in the runtime that starts the main agent and code-working children
(`omp plugin install quality@srobroek-omp`). Use it alongside `delivery` for the explicit
implementer, implementer-high, delegation, and PR-reviewer references. Installing a
marketplace entry alone does not prove an already-running session loaded it.

The policy applies in every repository and language. It prioritizes SOLID and idiomatic
encapsulation/boundaries over YAGNI, then uses KISS and DRY to avoid unnecessary structure.
A library or ORM with one consumer is justified when it simplifies the current solution.
Small scripts remain small; major refactors require a notice, not a new approval gate.

Before implementation, agents research shared and related code, relevant earlier work,
standard capabilities, and mature libraries/packages. They reuse a suitable capability
instead of recreating it, and record the candidates, sources, decision, and concrete
gaps that justify any custom code. Research stays proportional but precedes code writes;
workers can reuse verified task-local findings from their lead or a researcher.

Progressive disclosure:

1. `rule://quality-code-design` is always applied: the shared priorities, scope, and delegation contract.
2. `skill://quality-code-design` selects IMPLEMENT, INVESTIGATE, or REVIEW and routes by task.
3. The reuse guide is read before implementation; other principle examples, lifecycle
   guides, and language notes load only for the affected decision. Go, Rust, and other-paradigm
   guidance is conditional on code being designed, inspected, edited, or reviewed, not on
   unrelated files elsewhere in the repository. This is explicit on-demand routing, not a
   claim that OMP rulebook `globs` automatically inject content.

The core covers main/general agents, both implementers, built-in `task`, code scouts,
and reviewers. Leads also pass the rule and skill in briefs, supplying text if a child
cannot resolve the URIs. Scouts remain read-only. No bundled agent name is shadowed.
Agents report missing guidance instead of claiming coverage. This is instruction-based
steering and review, not deterministic proof that generated code meets the principles.

Review findings distinguish blockers, suggestions, accepted exceptions, and uncertainties.
The reference library covers each SOLID principle, OOP equivalents, YAGNI/KISS/DRY,
dependencies/ORMs, and researched supporting practices, with good/bad examples and exceptions.
Lifecycle references cover risk-based planning, behavioral verification, trust boundaries,
artifact assurance, mixed-version/data compatibility, recovery, retries, and release evidence.
Formal SLOs, canaries, attestations, and additional test techniques remain conditional on
the system's needs. Required project checks and release controls remain in force.
Primary-source links and inclusion decisions are in
[supporting principles](skills/quality-code-design/references/supporting-principles.md).

Verify installation with `omp plugin doctor` and read both
`rule://quality-code-design` and `skill://quality-code-design`. The repository's loader
smoke checks discovery and addressability; it does not measure behavioral compliance.

## Evaluating steering changes

Use the [evaluation guide](skills/quality-code-design/references/agent-evaluation.md)
with the bundled [task cases](skills/quality-code-design/assets/evaluation-cases.json)
and separate [grading rubric](skills/quality-code-design/assets/evaluation-rubric.json).
Keep the rubric and prior answers out of executor context. Compare baseline/candidate
outcomes on isolated fixtures; grade actual code and actions where available, and label
plan-only exercises accordingly. Track regressions, review misses/false positives,
unnecessary complexity, reuse research, and time/cost when recorded. These development
cases are not a held-out benchmark or an automatic CI evaluation service.

## Skills

| Name | When |
|------|------|
| `quality-code-design` | Code design, investigation, implementation, refactoring, or review in any language or repository |
| `watchdog-files` | Create, audit, or retune a project's `WATCHDOG.yml` / `WATCHDOG.md` advisor files |
| `advisor-resample` | Weekly, or after an advisor prompt or config change: census of delivered advisor notes and a hand-labeled precision sample with KEEP / RETIRE-CANDIDATE verdicts |

## Agents

| Name | Role | Model |
|------|------|-------|
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

Use the built-in `reviewer` for diff review. Specify the base ref, changed-file scope,
and the code-design policy in its brief. Ask for read-only, anchored findings, with no
heavy test suites or architecture changes. Use `pr-reviewer` from `delivery` when its
restricted PR-only evidence contract is appropriate.
