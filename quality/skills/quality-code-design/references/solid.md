# SOLID

## Contents

- Single responsibility (SRP)
- Open/closed (OCP)
- Liskov substitution (LSP)
- Interface segregation (ISP)
- Dependency inversion (DIP)

Use these principles to protect responsibilities and contracts in any paradigm. A responsibility is a coherent reason to change, not one method or one line. Examples below are TypeScript excerpts; functions, modules, protocols, and traits can carry the same contracts.

## Single responsibility (SRP)

**Do:** keep a coherent policy together and separate independently changing infrastructure, presentation, and business rules.
**Do not:** mix unrelated ownership or fragment every step into a service.

Bad: changing an invoice calculation requires navigating SMTP and SQL details.

```ts
async function issueInvoice(order: Order) {
  const total = order.lines.reduce((n, line) => n + line.price * line.quantity, 0);
  await db.execute("INSERT INTO invoices ...", [order.id, total]);
  await smtp.send({ to: order.email, html: `<p>Total: ${total}</p>` });
}
```

Good: calculation owns pricing; orchestration composes persistence and notification boundaries.

```ts
function invoiceTotal(lines: Line[]): number {
  return lines.reduce((n, line) => n + line.price * line.quantity, 0);
}
async function issueInvoice(order: Order, save: SaveInvoice, notify: NotifyInvoice) {
  const invoice = { orderId: order.id, total: invoiceTotal(order.lines) };
  await save(invoice);
  await notify(order.email, invoice);
}
```

Why: policy can change without rewriting delivery details. Real money handling uses the application's money representation; these excerpts focus on responsibility boundaries. Retry/atomicity requirements still need an explicit contract.

Overengineered bad: `LinePriceGetter`, `QuantityGetter`, `LineMultiplier`, and `TotalAccumulator` classes for this reduction. Good: retain the cohesive function.

**Exception:** a short disposable export can orchestrate parsing and output in one script. Split when either becomes independently reused, stateful, or policy-heavy; not because the function calls two collaborators.

## Open/closed (OCP)

**Do:** isolate an established axis of variation behind a stable contract.
**Do not:** create extension systems for hypothetical variants or interpret OCP as forbidding edits to existing code.

Bad: each supported payment provider adds another branch to pricing, checkout, and refunds.

```ts
if (provider === "a") { /* A request mapping inside checkout */ }
else if (provider === "b") { /* B request mapping inside checkout */ }
// The same branching and provider formats also appear in refundOrder().
```

Good: callers use the application contract; provider adapters own translation.

```ts
interface Payments {
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}
async function checkout(order: Order, payments: Payments) {
  return payments.charge(toChargeRequest(order));
}
```

Why: a new provider does not spread provider-specific conditionals through domain policy. One provider can justify this boundary when it already isolates an external dependency.

Counterexample: a closed set of three export formats is well served by an exhaustive switch in one module. Bad: runtime registration, discovery, and a plugin SDK with no extension requirement. Good: edit the switch when the closed set changes.

**Exception:** modify a stable abstraction when new requirements invalidate its contract. Migrate its callers; do not bolt on flags to preserve a misleading interface.

## Liskov substitution (LSP)

**Do:** preserve preconditions, postconditions, errors, side effects, ordering, and ownership/lifetime expectations promised by the contract.
**Do not:** satisfy a method signature while weakening its meaning.

Bad: the advertised repository supports saving, but one subtype cannot honor it.

```ts
interface Repository { load(id: string): Promise<Item>; save(item: Item): Promise<void> }
class ReadOnlyRepository implements Repository {
  load(id: string) { return readItem(id); }
  async save(_item: Item): Promise<void> { throw new Error("unsupported"); }
}
```

Good: expose only supported capabilities.

```ts
interface ItemReader { load(id: string): Promise<Item> }
interface ItemWriter { save(item: Item): Promise<void> }
class ReadOnlyRepository implements ItemReader {
  load(id: string) { return readItem(id); }
}
```

Second bad: replacing a writer whose resolved promise means "durably committed" with an adapter that resolves after queueing. Good: await durable completion or expose a separately named queued-write contract. Test the semantic promise, not only method presence.

Why: callers can substitute implementations without hidden branches for special cases.

**Exception:** an interface may explicitly permit unsupported operations, partial results, or different durability levels. Verify callers handle the documented result. Prefer narrower capabilities when unsupported cases otherwise dominate.

## Interface segregation (ISP)

**Do:** give each consumer the capability it needs; group operations with a shared contract.
**Do not:** force consumers or test doubles to implement unrelated methods, or split cohesive protocols into arbitrary one-method interfaces.

Bad:

```ts
interface UserPlatform {
  findUser(id: string): Promise<User>;
  deleteUser(id: string): Promise<void>;
  sendCampaign(id: string): Promise<void>;
  exportBilling(): Promise<Report>;
}
function displayProfile(platform: UserPlatform, id: string) { /* only finds a user */ }
```

Good:

```ts
interface UserLookup { findUser(id: string): Promise<User> }
function displayProfile(users: UserLookup, id: string) { /* consumes lookup only */ }
```

Why: changes to campaigns no longer affect profile consumers or their doubles. The concrete platform can implement several focused capabilities without wrapper classes for each.

**Exception:** keep `begin/commit/rollback` together when callers rely on one transactional lifecycle. Segregation must preserve protocols and invariants.

## Dependency inversion (DIP)

**Do:** express a domain operation's needs with domain-owned contracts and wire infrastructure at the composition boundary.
**Do not:** embed environment lookup, global clients, or vendor types in policy; do not equate inversion with a dependency-injection container.

Bad:

```ts
async function canShip(id: string) {
  const db = new VendorClient(process.env.DATABASE_URL!);
  return (await db.order.findUnique({ where: { id } })).payment_status === "paid";
}
```

Good:

```ts
type LoadOrder = (id: string) => Promise<Order>;
async function canShip(id: string, loadOrder: LoadOrder) {
  return (await loadOrder(id)).paymentStatus === "paid";
}
// The entry point supplies an adapter that maps ORM rows to Order.
```

Why: the business rule depends on its own need; the adapter owns credentials, persistence shape, and translation. This boundary has value with one database.

Overengineered bad: interfaces for deterministic arithmetic and an IoC container resolving each one. Good: call a pure helper directly; inject capabilities where variation or side effects matter.

**Exception:** framework-owned CRUD with no separate domain policy can use the framework's ORM directly in its data/application layer. Do not add a repository that merely renames every ORM method. Reassess when persistence details leak into independently changing policy.
