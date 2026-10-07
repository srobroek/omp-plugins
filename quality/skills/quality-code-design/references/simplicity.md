# YAGNI, KISS, and DRY

## Contents

- YAGNI: current need and reversible structure
- YAGNI: remove obsolete machinery
- KISS: total complexity and clarity
- KISS: proportional scripts, CI, and tools
- KISS: refactoring and growth
- DRY: knowledge versus resemblance
- DRY: ownership across boundaries
- DRY and KISS in tests

## YAGNI: current need and reversible structure

**Do:** implement current requirements and real design boundaries. Keep implementation choices contained so later extraction has a small, identifiable surface.
**Do not:** add hypothetical providers, options, caches, factories, or compatibility layers. Do not use YAGNI to justify hidden globals, leaking vendor data, or tangled responsibilities.

Bad: one CSV export gets an `ExportPluginRegistry`, dynamic discovery, and YAML-configured providers before any extension requirement exists.
Good: one `exportCsv(rows, writer)` operation uses the CSV library and an explicit output dependency.

Bad in the opposite direction: database calls, connection creation, and raw row fields are copied into every business function because "there is only one database."
Good: contain persistence in a module; expose operations in the consumer's vocabulary. Introduce a narrow interface, callback, or trait now if it protects a real boundary, even with one implementation.

Why: the good design supports today's need without making future extraction require a whole-program rewrite. "Easy to change later" is a test of coupling and ownership, not permission to implement tomorrow's feature.

**Exception:** a committed requirement or an external contract can justify extension behavior before the second implementation ships. Name that requirement; "we might need it" is insufficient.

## YAGNI: remove obsolete machinery

**Do:** remove replaced paths and unused configuration in the affected scope after migrating known callers.
**Do not:** keep dead interfaces or fallback code as insurance, or delete externally used behavior without checking its contract.

Bad: after a parser replacement, retain `oldParser`, a never-enabled feature flag, and two test suites indefinitely.
Good: migrate callers, verify compatibility that is actually required, then remove the obsolete parser and flag.

Why: unused machinery increases the number of states a maintainer must understand.

**Exception:** a documented rollout or external migration requires temporary compatibility. Record the consumer, removal condition, and residual risk; do not invent a migration requirement.

## KISS: total complexity and clarity

**Do:** minimize the work needed to understand, change, test, and operate the solution. Use explicit control flow and established libraries where they reduce that work.
**Do not:** optimize solely for line count, dependency count, cleverness, or number of files.

Bad:

```python
result = [(x, f(x)) for x in xs if valid(x) and not (seen.add(x) if x not in seen else True)]
```

Good:

```python
result = []
for item in xs:
    if not valid(item) or item in seen:
        continue
    seen.add(item)
    result.append((item, f(item)))
```

Why: the state change and filtering order are visible. Extra lines can reduce complexity.

Second bad: hand-written CSV escaping, date parsing, or migration tracking solely to avoid a dependency. Good: use an established library when its setup and lifecycle costs are smaller than maintaining the required behavior. Do not add a framework to replace one standard-library call.

**Exception:** a measured hot path can justify a less direct implementation. Keep the external contract simple, document the measurement, and preserve focused correctness checks.

## KISS: proportional scripts, CI, and tools

**Do:** use direct steps, clear inputs, checked failures, and a few functions when they clarify the task.
**Do not:** turn Bash, CI glue, a one-off migration, or a small utility into a full application architecture.

Bad: a two-command CI step gets a plugin system, generic workflow engine, and dependency-injection container.
Good: two named CI steps or a short script; extract a helper when several jobs share a rule that must remain consistent.

Bad:

```bash
for file in $(ls "$input"/*.json); do process $file; done
```

Good (Bash):

```bash
set -euo pipefail
shopt -s nullglob
for file in "$input"/*.json; do
  process "$file"
done
```

Why: quoting and explicit empty-input behavior solve the actual problem without an architecture. Decide whether no input is a valid no-op; if it is an error, check the array length and fail explicitly. `set -e` is not a complete error-handling strategy for conditional commands and pipelines.

**Exception:** a script that grows into a maintained tool with complex state or multiple independent workflows warrants modules or a more suitable language. Reassess when requirements change, not after an arbitrary line threshold.

## KISS: refactoring and growth

**Do:** fix violations in affected code and look for simplifications that reduce branching, duplication of knowledge, coupling, or obsolete paths. Revisit design whenever behavior is added or changed.
**Do not:** preserve a tangled design just because the patch can be smaller, or rewrite an unrelated subsystem for stylistic consistency.

Bad: add a fourth mode flag to a helper that now performs both file import and remote synchronization.
Good: separate the two operations around their independently changing behavior, sharing only the common parsing rule.

Bad: rename every class and adopt a new architecture while fixing one null check.
Good: fix the null check and simplify the surrounding redundant branch; report unrelated design debt separately.

Why: refactoring should make the current change easier to reason about and leave a smaller maintenance burden.

**Major-refactor notice:** a cross-module ownership change, public-contract migration, data migration, new substantial dependency, or rewrite of a maintained component needs a notice before execution. State affected paths/surfaces, benefit, compatibility risks, and verification. No new approval gate is created; existing permissions and assignment boundaries still apply. Workers notify their lead; the lead tells the user. If a fixed assignment excludes the refactor, report the opportunity rather than editing outside it.

**Exception:** an independently useful large refactor can belong in a separate change. Highlight it and explain the ordering; do not silently expand the current task.

## DRY: knowledge versus resemblance

**Do:** give each business fact or invariant one authoritative representation.
**Do not:** merge code that only happens to look alike or wait for an arbitrary third occurrence when a shared rule already exists.

Bad: shipping eligibility independently encodes the same paid-status rule in API, batch, and UI code, with each copy deciding policy.
Good: put the authoritative eligibility rule in the owning domain layer; presentation can display its result. Independently deployed clients may need a contract or generated representation rather than importing server code.

Bad:

```ts
function validateCode(value: string, mode: "coupon" | "employee") {
  // Identical length today, unrelated policies and owners.
  return value.length === 8;
}
```

Good:

```ts
function validCouponCode(value: string) { return value.length === 8; }
function validEmployeeCode(value: string) { return value.length === 8; }
```

Why: an employee policy change must not accidentally alter coupon validation. A shared string primitive is fine; a shared business rule requires shared meaning.

**Exception:** temporary duplication during migration is acceptable with a named authoritative rule, synchronization risk, and removal condition. Do not claim two definitions are independent when they must always change together.

## DRY: ownership across boundaries

**Do:** centralize shared contracts with their owner; generate derived schemas or clients when that removes manual drift.
**Do not:** create a cross-service "common" package that ties independent deployment and policy together merely to remove similar records.

Bad: billing and fulfillment import a giant shared `Customer` model and break on each other's internal field changes.
Good: each owns its internal representation; the shared event/API contract carries only agreed exchange data.

Why: duplication of representation can preserve separation of responsibilities; duplication of a required shared contract creates drift.

**Exception:** a single application with one ownership and release boundary can share a coherent domain type directly. Do not create adapters between every module by default.

## DRY and KISS in tests

**Do:** share expensive setup and stable fixture construction while keeping inputs and expected behavior visible. Verify boundary semantics and invariants affected by the change.
**Do not:** calculate expected results with the same helper being tested, hide the assertion inside a generic test framework, or write tests that only mirror trivial implementation.

Bad: `expect(total(order)).toBe(order.lines.reduce(theSameReducer, 0))`.
Good: a named example with independently specified expected output, plus boundary cases when they exercise a concrete risk.

Bad: a five-layer fixture factory for three readable test records.
Good: explicit records, or one small builder for irrelevant defaults with meaningful fields visible in the test.

Why: some duplication makes test intent and independent evidence clearer.

**Exception:** a large matrix can use table-driven tests when each case remains named and inspectable. Share setup, not a second copy of the production algorithm.
