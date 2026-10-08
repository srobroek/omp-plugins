# Dependencies, ORMs, and one consumer

## Research before adding a capability

**Do:** run these checks when a change adds a capability or dependency the repository does not already have. Keep a small task's search short, but perform it before implementation.

1. Search the codebase by behavior and domain meaning, not only by the desired function name. Read shared packages/utilities, relevant callers/tests, installed dependencies, manifests, and conventions.
2. Inspect related implementations and relevant earlier work available in the repository/history or linked task context. Determine whether existing local code can supply the need directly or become a cohesive shared capability. Do not search unrelated private repositories or assume unavailable prior work exists.
3. When nothing local fits, check standard-library, framework, and mature ecosystem options. Follow the project's existing choices first, then `rule://toolchain-languages` for per-language library picks when it is installed. Verify the candidate API/version and fit against authoritative documentation: required behavior, maintenance/support, compatibility, relevant security/licensing/deployment constraints, and operational cost. Popularity alone is not maturity or suitability.
4. Choose suitable existing shared code, direct reuse, a bounded extraction, an established library, or custom code supported by a concrete gap. Compare actual semantics and total complexity; do not invent a minimum consumer count or an arbitrary package-search quota. A new dependency the request did not name needs the user's approval before it is added.
5. Record a concise reuse decision in the existing task evidence: paths/symbols inspected, sources/versions consulted, choice, and material reasons. Reuse current task-local research when it addresses the same requirement.

**Do not:** start a custom implementation and research alternatives afterward, recreate a suitable available capability, or declare "nothing reusable" without examining candidates.

Bad: write a new pagination helper without reading the existing `shared/pagination` module or the framework's documented iterator.
Good: inspect both contracts and use the suitable existing capability; add only the domain behavior still missing.

Bad: copy a previous importer into a new command even though parsing and validation represent the same contract.
Good: extract that proven responsibility into the appropriate shared module and preserve existing consumers with focused checks.

Bad: turn unrelated password and invoice-number validators into one configurable utility because their current shapes match.
Good: keep independent policies separate; share only knowledge that must evolve together.

Bad: hand-write an archive parser while a maintained standard or ecosystem implementation meets the format and deployment requirements.
Good: verify the documented API and supported version, reuse it, and test the application's integration and failure behavior.

**Exception:** custom code is justified when researched options fail a required contract, deployment/license constraint, measured performance need, or present simplicity test. State the actual gap and the smallest custom scope; unfamiliarity or preference is insufficient. A standard command can be the appropriate reusable solution for a one-off script.

If a source/tool is unavailable, do not claim the check passed. Use available authoritative material or request research through the lead/researcher before implementing the unresolved capability. Read-only reviewers stay within their evidence contract: they assess reuse research only when the caller supplies it, and never fetch arbitrary URLs to fill the gap.

## Choose by present simplification

**Do:** compare the complete current solution: application code, correctness work, setup, migrations, operations, debugging, upgrades, and lock-in.
**Do not:** reject a dependency because only one component consumes it, or add it for hypothetical future scale.

Bad: hand-write relationship hydration, transaction handling, migrations, and mapping in several modules because "an ORM is overkill with one consumer."
Good: use the established ORM when its existing capabilities replace that required machinery and its lifecycle costs fit the project. Keep transaction ownership visible and persistence types contained where domain policy needs independence.

Bad in the other direction: add a framework, migration service, and repository hierarchy to a disposable script performing one parameterized query.
Good: use the standard database driver and explicit query when that is the simpler complete solution.

Why: YAGNI limits speculative functionality; it does not require rebuilding useful existing functionality by hand. KISS measures total complexity rather than installation size alone.

**Exception:** deployment restrictions, unsupported database features, performance measurements, or dependency policy can make the hand-written solution preferable. Document the actual constraint and what it costs; do not invent a policy to avoid evaluating the library.

## Keep transaction and persistence boundaries meaningful

Bad:

```ts
// Domain callers depend on ORM query syntax and partially loaded row state.
interface Orders { find(args: VendorQuery): Promise<VendorOrderRow> }
```

Good when domain policy exists:

```ts
interface Orders { reserveStock(order: Order): Promise<ReservationResult> }
// The adapter owns the transaction needed for the promised reservation semantics.
```

Good for simple CRUD: use the ORM in the application/data layer directly; omit a generic repository that merely duplicates its complete API.

**Do:** name atomicity, durability, failure, and partial-success semantics in the operation contract when callers depend on them. Keep all changes that must be atomic inside one transaction owner.
**Do not:** split one transaction into multiple repositories that each silently commit, or let lazy loading create invisible I/O in pure domain operations.

**Exception:** a framework's unit-of-work convention can own the transaction if that lifecycle is clear and consistently honored. Follow its idiom instead of adding a parallel transaction framework.

## Leave extraction practical

Bad: a "temporary" direct SDK call spreads provider-specific errors and data types through every caller.
Good: one adapter/module maps provider results and errors to application meaning. A later second adapter can fulfill that contract without rewriting business rules.

Bad: wrap every library function in a one-for-one local facade regardless of exposure.
Good: wrap the boundary the application actually owns; use stable utility libraries directly inside cohesive modules.

Why: containment is valuable now; comprehensive replacement frameworks are not automatically valuable.

**Exception:** vendor types can remain inside code whose responsibility is vendor integration. Do not pretend the integration adapter itself must be vendor-independent.
