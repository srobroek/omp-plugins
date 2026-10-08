# quality

Portable code-design steering, adversarial challenge, logic prototyping, WATCHDOG advisor-file authoring, and advisor note resampling.

## Code design policy

Enable `quality` in the runtime that starts the main agent and code-working children
(`omp plugin install quality@srobroek-omp`). Installing a marketplace entry alone does not
prove an already-running session loaded it. `delivery`, `architecture`, and `speckit`
point their agents at this skill and its references.

The policy applies in every repository and language. It prioritizes SOLID and idiomatic
encapsulation/boundaries over YAGNI, and applies DRY to shared knowledge rather than
resemblance. A library or ORM with one consumer is justified when it simplifies the
current solution. Refactoring stays within the requested change; a major refactor needs
the user's approval.

When a change adds a capability the repository lacks, agents check the standard library
and mature packages before writing custom code. A dependency the request did not name
needs the user's approval.

Progressive disclosure:

1. `rule://quality-code-design` is always applied: a short core of priorities and scope.
2. `skill://quality-code-design` selects IMPLEMENT, INVESTIGATE, or REVIEW and routes by task.
3. References load only for the affected decision: principle examples, deep modules and
   seams, debugging, the test-first loop, lifecycle guides, and language notes. Go, Rust,
   and other-paradigm guidance is conditional on code being designed, inspected, edited,
   or reviewed, not on unrelated files elsewhere in the repository. This is explicit
   on-demand routing, not a claim that OMP rulebook `globs` automatically inject content.

Always-applied rules reach every child session that loads `quality`; what a lead's brief
must carry is set by `delivery`'s fan-out rule. Scouts remain read-only. No bundled agent
name is shadowed. This is instruction-based steering and review, not deterministic proof
that generated code meets the principles.

Review findings distinguish blockers, suggestions, accepted exceptions, and uncertainties.
Local reviews pin a fixed point, include staged and unstaged work, and report Standards
and Spec separately. The reference library covers each SOLID principle, OOP equivalents,
deep modules, YAGNI/KISS/DRY, dependencies/ORMs, and researched supporting practices, with
good/bad examples and exceptions. Lifecycle references cover risk-based planning, decision
records, domain terms, behavioral verification, trust boundaries, artifact assurance,
mixed-version/data compatibility, recovery, retries, and release-state evidence. Formal
SLOs, canaries, attestations, and additional test techniques remain conditional on the
system's needs. Required project checks and release controls remain in force.
Primary-source links and inclusion decisions are in
[supporting principles](skills/quality-code-design/references/supporting-principles.md).

Verify installation with `omp plugin doctor` and read both
`rule://quality-code-design` and `skill://quality-code-design`. The repository's loader
smoke checks discovery and addressability; it does not measure behavioral compliance.

## Evaluating steering changes

Development cases and their grading rubric live in
[tests/code-design-eval](tests/code-design-eval/README.md), outside the installed skill
directory. Run comparisons with the owner's `tune-model-prompt` method. These cases are
not a held-out benchmark or an automatic CI evaluation service.

## Skills

| Name | When |
|------|------|
| `quality-code-design` | Code design, investigation, implementation, refactoring, review, debugging, or test-first work in any language or repository |
| `prototype-logic` | A throwaway single-file HTML demo over a pure reducer or state machine, to test a logic or state model before building it |
| `watchdog-files` | Create, audit, or retune a project's `WATCHDOG.yml` / `WATCHDOG.md` advisor files |
| `advisor-resample` | Weekly, or after an advisor prompt or config change: census of delivered advisor notes and a hand-labeled precision sample with KEEP / RETIRE-CANDIDATE verdicts |

## Agents

| Name | Role | Model |
|------|------|-------|
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

Use the built-in `reviewer` for diff review. Specify the base ref and changed-file scope
in its brief, and ask for read-only, anchored findings. Use `pr-reviewer` from `delivery`
when its restricted PR-only evidence contract is appropriate.

## Attribution

Parts of this plugin derive from [mattpocock/skills](https://github.com/mattpocock/skills)
1.2.3 under the MIT licence. `skills/prototype-logic` is vendored with its own LICENSE and
NOTICE. Content folded into `quality-code-design` references is listed in [NOTICE](NOTICE),
with the licence text in [LICENSE-mattpocock-skills](LICENSE-mattpocock-skills).
