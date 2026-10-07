# Supporting principles

## Contents

- Behavioral contracts
- Least knowledge and locality of change
- Predictability and explicit effects
- Command-query separation
- Existing coverage and limits

These are supporting checks, not a new ranking above SOLID and idiomatic encapsulation. The inclusion choices and examples are this policy's recommendations; the linked sources explain the underlying ideas. Read only the relevant section.

## Behavioral contracts

**Do:** specify required inputs, promised results, invariants, and relevant failure/side-effect semantics at real boundaries. Validate untrusted input before domain operations.
**Do not:** rely on a matching signature when implementations differ in meaning, or add repeated checks everywhere after a boundary already establishes an invariant.

Bad: `reserve(quantity)` silently clamps negative inputs and sometimes returns success without reserving stock.
Good: reject invalid quantity at entry; define success as a completed reservation and preserve the documented failure state.

Why: callers and implementations need compatible obligations. This strengthens the existing LSP and invariant checks.

**Exception:** use ordinary types, focused tests, and concise API comments when sufficient; no contract framework or formal specification is required for a small helper.

Source: [Eiffel's Design by Contract introduction](https://www.eiffel.com/values/design-by-contract/introduction/).

## Least knowledge and locality of change

**Do:** depend on collaborators' public meaning rather than their internal layout; keep related policy with its owner.
**Do not:** traverse a chain of implementation objects or add forwarding methods solely to satisfy a dot-count rule.

Bad: shipping reads `order.customer.record.addressTable.zoneCode` and owns the interpretation.
Good: obtain the shipping destination through the domain's public contract; representation changes remain local.

Why: a caller's knowledge of internal structure creates additional reasons it must change.

**Exception:** ordinary traversal of a transparent data record or a fluent builder is not automatically a violation. Look for representation coupling, not punctuation.

Source: [Law of Demeter, general formulation](https://www2.ccs.neu.edu/research/demeter/demeter-method/LawOfDemeter/general-formulation.html).

## Predictability and explicit effects

**Do:** use domain names, idiomatic constructs, visible I/O boundaries, explicit error outcomes, and controllable clock/randomness when behavior depends on them.
**Do not:** conceal network writes in property access or turn failed reads into success-shaped empty data.

Bad: `loadOrders()` returns an empty list after a timeout, so callers conclude there are no orders.
Good: distinguish a successful empty result from failure. A documented fallback identifies stale/partial data and its risk.

Bad: `DataManager.process(mode=4)` performs an undocumented payment capture.
Good: `capturePayment(request)` states the domain action and exposes its result/failure contract.

**Exception:** a fallback can be part of a reliability contract. Bound it and make its degraded result observable; do not crash an entire service under a blanket "fail fast" slogan.

Source: [Dan North's CUPID properties](https://dannorth.net/blog/cupid-for-joyful-coding/). Adopt predictability, idioms, and domain language as review lenses; composition and cohesive purpose are already covered here. This policy retains the user's SOLID priority rather than adopting CUPID as its replacement.

## Command-query separation

**Do:** make inspection operations free of surprising state changes and name commands for their effects.
**Do not:** silently mutate business state from a getter or split an atomic operation into an unsafe read-then-write sequence for formal compliance.

Bad: `getBalance()` also settles pending payments.
Good: `balance()` inspects; `settlePayments()` explicitly changes state.

**Exception:** `pop()`, `next()`, atomic compare-and-swap, and create operations returning an identifier legitimately combine an effect with a result. Preserve atomicity and clear naming.

Why: callers can understand effects without inspecting each implementation. This is method/API guidance, not a requirement for CQRS infrastructure, separate databases, or event sourcing.

Sources: [Command Query Separation](https://martinfowler.com/bliki/CommandQuerySeparation.html) and [CQRS tradeoffs](https://martinfowler.com/bliki/CQRS.html), Martin Fowler.

## Existing coverage and limits

**AHA / avoiding hasty abstractions:** already implemented by the DRY distinction between shared knowledge and coincidental similarity, and by the present-value test for abstractions. Bad: merge unrelated validators after two matching examples. Good: share only the common rule that must evolve together. Do not add a mandatory rule-of-three threshold; a real boundary can justify one implementation. See [Kent C. Dodds on AHA](https://kentcdodds.com/blog/aha-programming).

**Tell, don't ask:** already represented by invariant-owning operations. Bad: callers read and mutate account internals to perform a withdrawal. Good: the owner validates the withdrawal. Exception: DTOs, functional values, and legitimate queries need no artificial behavioral wrapper. [Fowler's discussion](https://martinfowler.com/bliki/TellDontAsk.html) also cautions against mechanically removing queries.

**Separation of concerns, high cohesion/low coupling, composition over inheritance:** covered by SRP, DIP, and encapsulation. Review those properties once rather than issuing several findings for the same root cause.

**Architectural and workflow patterns:** DDD, hexagonal architecture, CQRS, event sourcing, microservices, and mandatory TDD are not universal requirements of this policy. Evaluate a pattern against current requirements and existing conventions. Bad: install an architectural stack to satisfy a principle. Good: adopt the smallest structure that solves the concrete boundary or behavior problem.
