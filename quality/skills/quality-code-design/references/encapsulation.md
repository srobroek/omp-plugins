# OOP principles and their equivalents

## Contents

- Encapsulation and information hiding
- Valid state and invariants
- Abstraction
- Inheritance and substitutability
- Polymorphism
- Composition and coupling

Use objects when they bind meaningful state and behavior. Use modules, packages, pure functions, and types when those express the design more directly. OOPS is not a requirement to turn every function into a class.

## Encapsulation and information hiding

**Do:** expose operations and stable meaning; keep representation and mutation ownership private.
**Do not:** treat getters/setters as encapsulation when they expose unrestricted mutation.

Bad:

```ts
class Cart { items: Line[] = []; }
cart.items.push({ sku: "a", quantity: -5 });
```

Good:

```ts
class Cart {
  #items: Line[] = [];
  add(sku: string, quantity: number) {
    if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("invalid quantity");
    this.#items.push({ sku, quantity });
  }
  snapshot(): ReadonlyArray<Readonly<Line>> {
    return this.#items.map(item => ({ ...item }));
  }
}
```

Why: the owner controls mutation; callers cannot change these flat stored records through a returned alias. Nested mutable values need deliberate copying or immutable representation too.

**Exception:** plain data-transfer records need no behavioral class when they have no owned invariants. Validate untrusted input at the boundary; use read-only or copied values where ownership requires it.

## Valid state and invariants

**Do:** establish invariants in construction and preserve them during transitions. Make invalid states unrepresentable when the language permits it.
**Do not:** rely on every caller remembering a multi-step setup protocol.

Bad:

```ts
type Job = { running: boolean; finished: boolean; result?: Result };
const job = { running: true, finished: true }; // contradictory
```

Good:

```ts
type Job =
  | { state: "pending" }
  | { state: "running"; startedAt: Date }
  | { state: "finished"; result: Result };
```

Why: each state carries what its consumers may rely on. Constructors/factories validate runtime values; type declarations alone do not validate incoming JSON.

**Exception:** a serializer or database layer can use a loose intermediate record. Convert and validate before handing it to domain code; do not spread the intermediate representation across the application.

## Abstraction

**Do:** name operations in the consumer's vocabulary and hide decisions likely to change independently.
**Do not:** create empty wrappers or expose internals through a supposedly stable contract.

Bad:

```ts
interface Orders { query(sql: string): Promise<VendorRow[]> }
// Every consumer still knows tables, columns, and vendor row conventions.
```

Good:

```ts
interface Orders { findReadyToShip(): Promise<ReadyOrder[]> }
```

Why: the contract expresses the application's need. A module-exported function can do the same job; an interface is not mandatory.

**Exception:** SQL is the correct public abstraction for a SQL execution tool. Judge the actual consumer, not a universal ban on low-level APIs.

## Inheritance and substitutability

**Do:** inherit only when the subtype honors the base contract and the lifecycle is designed for extension.
**Do not:** inherit just to reuse implementation or build combinatorial hierarchies.

Bad: `ReadOnlyFile extends WritableFile` overrides `write()` to fail; callers must inspect concrete types. Good: separate readable and writable capabilities, or wrap a readable handle.

Bad: `CachedEncryptedRemoteStore extends EncryptedRemoteStore extends RemoteStore` couples ordering and transport. Good: explicit decorators around a common store contract when all three behaviors are required.

Why: composition permits changing one concern without inheriting unrelated public behavior. Decorators still must preserve error, ordering, and durability semantics.

**Exception:** framework extension points or a shallow, stable subtype hierarchy can be simpler than a parallel adapter system. Honor documented base-class hooks and LSP; do not replace valid inheritance for compliance alone.

## Polymorphism

**Do:** choose dispatch that matches whether variants are open or closed.
**Do not:** scatter concrete-type checks or assume runtime interface dispatch is always superior.

Bad: handlers throughout the application use `instanceof EmailNotice` and `instanceof SmsNotice` and duplicate delivery logic.

Good for an open extension boundary:

```ts
type SendNotice = (notice: Notice) => Promise<void>;
async function notify(notice: Notice, send: SendNotice) { await send(notice); }
```

Good for a closed domain:

```ts
type Shape = { kind: "circle"; radius: number } | { kind: "square"; side: number };
function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle": return Math.PI * shape.radius ** 2;
    case "square": return shape.side ** 2;
  }
}
```

Why: callbacks, interfaces, traits, and exhaustive matching are alternative ways of expressing variation.

**Exception:** a localized type check at a parsing or adaptation boundary is legitimate. Repeated checks in domain consumers signal a missing contract.

## Composition and coupling

**Do:** pass collaborators explicitly and give each mutable resource an owner. Keep access through a collaborator's public contract.
**Do not:** use global service locators, pass the entire application context to every function, or navigate other modules' internals.

Bad: `app.services.database.connection.driver.orders...` inside shipping policy.
Good: pass `loadOrder` or `orders` to the shipping operation, with configuration and connection lifetime owned by the entry point.

Bad: a two-line string normalizer needs `NormalizerFactory`, `NormalizerService`, and `NormalizerRegistry`.
Good: `normalizeName(text)` remains a pure function. Revisit when it gains locale policy, mutable state, or external dependencies; do not automatically add classes.

Why: explicit dependencies make later extraction practical without speculative extension machinery.

**Exception:** established framework context can be appropriate inside framework adapters. Narrow what crosses into independent policy code.
