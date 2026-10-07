# Dependencies, ORMs, and one consumer

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
