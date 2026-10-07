---
name: quality-code-design
description: Use when designing, investigating, implementing, refactoring, or reviewing code; applies SOLID, idiomatic OOP equivalents, YAGNI, KISS, and DRY across languages and repositories.
---

# Code design and review

TRIGGER
+ Design, investigate, write, modify, refactor, or review code in any agent role or language.
+ Add behavior to an existing function, module, type, script, or service.
- Prose-only work or mechanical execution of an unchanged command needs no design analysis.

## Workflow

1. Apply `rule://quality-code-design`. Identify the current behavior, affected responsibility, callers, contracts, invariants, and permitted edit scope from available evidence. Missing context is an uncertainty, not proof of a defect.
2. Choose IMPLEMENT, INVESTIGATE, or REVIEW. In IMPLEMENT, compare the direct solution with an abstraction only where a concrete boundary, invariant, dependency, or present simplification warrants it. In INVESTIGATE, map relevant responsibilities, contracts, coupling, and simplification opportunities within the scout/task brief; do not edit. In REVIEW, inspect changed behavior using only evidence allowed by the reviewer contract; stay read-only.
3. Load only relevant references from the table. Select language guidance from files and symbols actually in scope or the stated implementation language; an unrelated language elsewhere in the repository does not trigger it. For mixed-language work, load only the affected languages. In REVIEW, always load the review guide and consult principle examples for candidate findings. Do not load the whole library by default.
4. In IMPLEMENT, fix violations in the affected code and simplify within scope. Before a major refactor, notify the user (or lead for a worker) of the affected surface, benefit, and risk. Verify behavior and contracts with focused checks; preserve behavior unless the request changes it.
5. In REVIEW, evaluate all five subjects, including each SOLID principle. Mark a topic inapplicable internally when the code has no relevant construct. Report evidence-backed findings, justified exceptions, and limits of evidence using the existing output schema.
6. Reassess decisions when behavior changes. Record non-obvious exceptions near the decision or in an existing design record: reason, alternatives, residual risk, and concrete revisit trigger. Surface them in the handoff; omit ceremonial compliance reports on clean changes.

## Reference selection

All references are directly accessible as `skill://quality-code-design/references/<file>`; relative links below also work from this skill. Examples are focused excerpts, not complete applications. Undefined collaborators stand for application-specific code.

| Situation → reference | Coverage |
|---|---|
| Responsibilities, extension, contracts, or dependencies → [solid.md](references/solid.md) | SRP, OCP, LSP, ISP, DIP; underdesign and overengineering |
| State, objects, modules, abstraction, or composition → [encapsulation.md](references/encapsulation.md) | Encapsulation, information hiding, invariants, abstraction, inheritance, polymorphism, composition |
| Scope, duplication, or simplifying a solution → [simplicity.md](references/simplicity.md) | YAGNI, KISS, DRY, reversible design, refactoring, scripts, tests |
| Library, ORM, or persistence choice → [dependencies.md](references/dependencies.md) | Present simplification, one consumer, operational cost, boundary leakage |
| Contracts, internal knowledge, naming, errors, or effects → [supporting-principles.md](references/supporting-principles.md) | Design by Contract, least knowledge, predictability, command-query separation; researched sources and limits |
| Go code → [go.md](references/go.md) | Consumer interfaces, structs, composition, package boundaries, errors |
| Rust code → [rust.md](references/rust.md) | Ownership, enums, traits, privacy, dispatch, error contracts |
| Class-based, dynamic, functional, or procedural code → [other-paradigms.md](references/other-paradigms.md) | TypeScript, Python, Java/C#, functional and C-style designs |
| Code or PR review → [review.md](references/review.md) | Explicit checklist, severity, evidence, exceptions, review examples |

## Rules

MUST Preserve meaningful boundaries and invariants before minimizing code. Do not trade them away under YAGNI or KISS.
MUST Judge abstractions and dependencies by the complexity they remove today, including lifecycle and operational costs. No minimum consumer count applies.
MUST Keep this policy portable; adapt constructs to language conventions and project constraints without imposing an OOP framework.
MUST Use explicit behavioral contracts, limited knowledge of internals, predictable effects/errors, and domain names where those concerns arise; supporting principles add no mandatory architecture.
MUST Edit generated or vendored behavior through its owned source, generator, or upstream mechanism.
NOT Introduce classes, interfaces, configuration, frameworks, or tests merely to demonstrate compliance.
NOT Expand an assigned worker's scope or bypass higher-priority instructions, approval requirements, reviewer evidence restrictions, or output contracts.
