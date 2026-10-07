---
name: quality-code-design
alwaysApply: true
---

# Maintainable code

MUST Apply this policy whenever designing, investigating, writing, changing, or reviewing code, regardless of agent role, repository, or language. It covers main/lead agents, `implementer`, `implementer-high`, general/`task` agents, code scouts, tests, scripts, and infrastructure logic. Read-only agents stay read-only; non-code tasks need no design workflow.

MUST Prioritize SOLID and encapsulation, abstraction, substitutability, composition, and protected invariants over YAGNI when they protect a real responsibility or boundary. Use the language's idioms: functions, modules, packages, interfaces, traits, and algebraic data types can fulfill these principles without classes or inheritance.

MUST Keep YAGNI strict about speculative features and unused extension machinery. Preserve cohesive modules, explicit dependencies, and contained implementation details so later extraction remains practical. Do not spread coupling now to avoid an abstraction. A library, ORM, or boundary with one consumer is justified when it reduces present total complexity; consumer count alone decides nothing.

MUST Use KISS to choose the least complex design that preserves those properties. Use DRY for knowledge that must change together, not coincidentally similar code. Revisit structure whenever behavior is added or changed; grow it only when responsibilities, invariants, or dependencies warrant it. Keep CI, Bash, one-off scripts, and small tools proportional to their job.

MUST Research reuse before writing or changing code, including tests and scripts: inspect shared modules, related implementations and relevant earlier work, then check standard-library and mature package/library options against authoritative documentation. Reuse a suitable capability instead of recreating it. Extract earlier code only when the responsibility is shared. Record paths/symbols, external sources/versions, the chosen option, and concrete reasons for custom code in the existing task evidence. Keep the search proportional, not optional; reuse current task-local research when it covers the same need. Resolve missing research before implementation through available sources or the lead; do not invent results or silently skip it.

MUST Identify the intended behavior, affected contracts, and material failure risks before editing. Scale planning and verification by uncertainty, consequences, and reversibility; file or line counts alone decide neither safety nor design. Load only the lifecycle guidance triggered by the change. Preserve required project checks, verify the accepted behavior, and distinguish implementation, verification, deployment, and observation in completion claims. A PR request does not authorize production release.

MUST Before code work, read `skill://quality-code-design` and only its task-relevant references. Load language guidance only for languages being designed, inspected, edited, or reviewed. Fix violations in the changed code and seek refactors that simplify the affected responsibility. Stay within assigned scope; flag unrelated opportunities separately. Notify the user before a major refactor with scope, reason, and risks; notification alone is not an approval gate. Workers notify their lead before proceeding within their assignment; leads surface the notice to the user.

MUST Include this policy and its skill URI in code-work delegation briefs, including `scout`, `task`, `implementer`, `implementer-high`, and reviewers; if the child lacks rule/skill access, supply the core and relevant reference text. Scouts identify responsibilities, contracts, coupling, and simplification opportunities with evidence within their assigned investigation; they do not edit or issue unsolicited approval. Surface unavailable guidance; never claim it was loaded.

MUST During code review, assess every principle explicitly. Report concrete evidence, consequence, and a proportionate fix; separate blockers, suggestions, and accepted exceptions. Accept a documented reason that holds for the current change, and tell the user the residual risk and revisit trigger. Do not block on pattern preference or class/interface counts. Follow the task's existing output and evidence-access contracts.
