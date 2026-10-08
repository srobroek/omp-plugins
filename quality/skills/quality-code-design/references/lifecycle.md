# Planning and feedback

Read for uncertain scope, work sequencing, consequential decisions, domain terminology, or recurring delivery problems. Keep the main design priorities; these practices add no mandatory project methodology.

## Scale by consequences

**Do:** identify the observable result, affected contracts, uncertainty, blast radius, and recovery difficulty before choosing workflow depth. Preserve project-required records and checks.
**Do not:** infer safety from file count, line count, or the label "script"; require a full specification for a known local edit.

Bad: a one-line tenant authorization change receives only a syntax check.
Good: inspect the access boundary and verify allowed and denied cases, including cross-tenant access.

Bad: a mechanical rename requires a new architecture document.
Good: confirm callers with available tooling, run the relevant checks, and keep a brief acceptance note.

**Exception:** regulated or project-mandated records still apply. State the actual requirement rather than inventing a gate.

## Small coherent batches

**Do:** split work into independently understandable, verifiable changes; keep dependent edits together unless an intermediate state remains compatible. Integrate frequently within the project's branch/review policy.
**Do not:** combine unrelated cleanup with a fix, or split a shared contract from its callers into broken intermediate commits.

Bad: an authentication fix also replaces the ORM and reformats the repository.
Good: keep the fix and its directly enabling simplification together; sequence the wider migration separately with acceptance for each increment.

Bad: require direct pushes to main or a deployment quota to claim continuous integration.
Good: use short-lived branches and fast feedback while retaining required reviews and checks.

**Exception:** a cohesive atomic change can be large. Explain why splitting would reduce correctness or reviewability. A major refactor still needs the user's approval ([simplicity.md](simplicity.md)).

## Durable decisions

**Do:** record a decision only when all three hold: it is hard to reverse, it would surprise a future reader without context, and it came from a real trade-off between genuine alternatives. Typical cases: architectural shape, integration patterns between contexts, technology choices with lock-in, boundary and ownership decisions, deliberate deviations from the obvious path, constraints invisible in the code, and non-obvious rejected alternatives. Record context, decision, and why in a paragraph; add status, considered options, or consequences only when they carry information.
**Do not:** document every helper function, or treat an old exception as permanent permission.

Bad: "Temporary direct SQL" remains the only rationale after a disposable importer becomes a service.
Good: revisit transaction ownership, schema coupling, and verification when the importer gains long-lived consumers; update or supersede its decision record.

Where: reuse the project's existing decision-record convention. With none, use `docs/decisions.md` or `docs/decisions/NNNN-slug.md`, never a new `docs/adr/`. Numbered records have one numbering owner: in a multi-agent run the lead assigns the number and workers propose the record. Retain superseded rationale.

**Exception:** a local comment or task note suffices when the tradeoff is small and understandable. A decision record is a format for significant decisions, not a prerequisite for coding.

## Domain terms

- Challenge a term that conflicts with the project's existing glossary or code names, and propose one canonical term for a vague or overloaded one ("account": Customer or User?).
- Stress-test stated domain relationships with concrete edge-case scenarios, and check stated behavior against the code; surface a contradiction instead of picking a side.
- Record resolved terms in the project's existing glossary. Create a new glossary file such as `CONTEXT.md` only when the task authorizes it.

## Feedback and outcome measures

**Do:** after an escaped defect or repeated friction, identify the mechanism and the smallest useful prevention: a regression case, clearer contract, focused automated check, or corrected guidance. Measure outcomes in the application's context.
**Do not:** add a broad rule after every isolated typo, or rank people and agents by lines of code, PR count, abstraction count, or number of findings.

Bad: reward a reviewer for generating more comments, or an implementer for creating more files.
Good: track accepted behavior, escaped defects, rework, review effort, and time/cost together. Preserve a baseline and check whether the intervention improved the actual problem.

For ongoing delivery, DORA's five metrics are change lead time, deployment frequency, failed deployment recovery time, change fail rate, and deployment rework rate. Use trends for one application/service; do not impose cross-project quotas. Start with existing evidence instead of building a metrics platform for a small tool.

**Exception:** a one-off tool needs a verified result and usable handoff, not a permanent observability or reporting program.

## Sources and limits

- [DORA small batches](https://dora.dev/capabilities/working-in-small-batches/) supports short feedback loops; it does not prescribe a universal PR size.
- [DORA delivery metrics](https://dora.dev/guides/dora-metrics/) cautions against quotas and comparisons across different contexts.
- [Michael Nygard on architecture decision records](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) describes small records for significant decisions.
- [DORA 2025 research](https://dora.dev/research/2025/dora-report) describes AI as amplifying the surrounding system. Observational associations do not prove that one steering rule causes better outcomes.
