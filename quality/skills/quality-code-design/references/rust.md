# Rust: conditional language guidance

Load only when the task designs, investigates, changes, or reviews Rust code. Express design through ownership, modules, structs, enums, and traits rather than simulated inheritance.

Language reference: [The Rust Book on object-oriented characteristics](https://doc.rust-lang.org/book/ch18-01-what-is-oo.html).

## Ownership, privacy, and invariants

**Do:** give resources clear owners, borrow when ownership need not move, and validate invariant-bearing values at construction.
**Do not:** use pervasive `Arc<Mutex<_>>`, cloning, or interior mutability just to avoid deciding ownership.

Bad:

```rust
pub struct Quantity(pub i32); // any caller can construct -1
```

Good:

```rust
pub struct Quantity(u32);
impl Quantity {
    pub fn new(value: u32) -> Result<Self, &'static str> {
        if value == 0 { Err("quantity must be positive") } else { Ok(Self(value)) }
    }
    pub fn get(&self) -> u32 { self.0 }
}
```

Why: construction establishes a usable invariant. Serialization and database decoding must honor it too; deriving deserialization without validation can reopen invalid states.

**Exception:** shared mutation is appropriate when multiple owners really must coordinate. Choose synchronization around the actual invariant, document lock/lifetime semantics, and avoid holding locks across unrelated work.

## Enums for closed variants; traits for boundaries

**Do:** use exhaustive enums for closed domain alternatives; use traits when behavior is open or a consumer boundary needs substitution.
**Do not:** create a trait for every struct or erase a closed domain into unstructured strings and downcasts.

Bad: a job has several boolean flags and an optional result, allowing contradictory states.
Good:

```rust
enum JobState {
    Pending,
    Running { started_at: std::time::Instant },
    Finished { result: JobResult },
}
```

Bad: persistence details and provider errors appear in every domain operation.
Good at a real persistence boundary:

```rust
trait OrderLookup {
    fn find(&self, id: OrderId) -> Result<Option<Order>, LookupError>;
}
```

Why: both enums and traits express abstraction and polymorphism. The operation contract, including errors and side effects, matters more than the construct.

**Exception:** a closed variant set can become open when actual extension requirements arrive. Revisit then; do not add dynamic loading ahead of that need.

## Static and dynamic dispatch

**Do:** choose generics or `dyn Trait` based on runtime selection, API clarity, code size, and measured performance needs.
**Do not:** proliferate generic parameters through every layer or box everything under the label SOLID.

Bad: a small calculation takes six unconstrained type parameters because all helpers have a one-method trait.
Good: a plain function over concrete domain values.

Good for compile-time substitution:

```rust
fn eligible(store: &impl OrderLookup, id: OrderId) -> Result<bool, LookupError> {
    Ok(store.find(id)?.is_some_and(|order| order.is_paid()))
}
```

Good for heterogeneous runtime selection: accept `&dyn OrderLookup` or own a `Box<dyn OrderLookup>` when that lifecycle is needed. Keep the trait dyn-compatible if using trait objects.

**Exception:** measured hot paths or library ergonomics can justify additional generic structure. State the requirement rather than assuming zero-cost abstractions are always simpler for maintainers.

## Composition, error contracts, and resource lifetimes

**Do:** compose fields and functions, use `Result` for expected failures, and keep drop/transaction/resource semantics explicit.
**Do not:** use `Deref` to simulate subtype inheritance, panic for ordinary I/O failure, or silently weaken a trait's semantic promises.

Bad: an adapter implements a durable-save trait but returns `Ok(())` after enqueueing; another calls `unwrap()` on network failure.
Good: await/confirm the promised persistence and return the documented error, or expose an explicitly queued operation with its own result contract.

Why: Rust's type checker does not verify every behavioral contract. Ownership safety does not replace LSP, SRP, or error semantics.

**Exception:** `expect()` can document an invariant already established by local construction, and a disposable tool can use a simple application-level error type. Do not create a public error taxonomy for a one-off script unless callers need one.
