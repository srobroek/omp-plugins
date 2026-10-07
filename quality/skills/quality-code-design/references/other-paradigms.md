# Other language paradigms

Load only the section matching the code under discussion. These examples illustrate portable design principles, not required frameworks.

## TypeScript and JavaScript

**Do:** use modules, functions, structural types, and discriminated unions for stateless behavior and closed variants; use classes for owned state and lifecycle.
**Do not:** implement a class hierarchy merely to get polymorphism, or mistake static types for runtime input validation.

Bad:

```ts
class UppercaseService { run(value: string) { return value.toUpperCase(); } }
class UppercaseFactory { create() { return new UppercaseService(); } }
```

Good:

```ts
const uppercase = (value: string): string => value.toUpperCase();
```

When locale policy, caching, or I/O is added, reassess responsibilities and dependencies. A callback or explicit options value can still be simpler than an object.

**Exception:** a framework's lifecycle requires an injectable class. Use its normal convention; do not build factories around a class the framework already constructs.

## Python

**Do:** use functions for transformations, dataclasses for records, classes for owned behavior, and protocols where a typed consumer boundary helps.
**Do not:** add abstract base classes for every helper, mutate global clients from domain functions, or assume underscore-prefixed fields enforce runtime privacy.

Bad: `ReportServiceFactory` creates a stateless `ReportService` just to format three fields.
Good: `format_report(record)` is a function.

Good at a real delivery boundary:

```python
from typing import Protocol

class ReportSender(Protocol):
    def send(self, report: str) -> None: ...

def publish(report: str, sender: ReportSender) -> None:
    sender.send(report)
```

Why: structural typing documents the capability without forcing an inheritance hierarchy. Duck typing or a callable can be sufficient for a small local collaboration.

**Exception:** an ABC is useful when runtime enforcement or shared lifecycle behavior is actually required. A frozen dataclass is only shallowly immutable; validate and protect nested mutable data when invariants depend on it.

## Java and C#

**Do:** use cohesive classes, records/value objects, narrow interfaces at real boundaries, and ordinary constructor injection.
**Do not:** add an interface, factory, abstract factory, and service wrapper to each concrete class by convention alone.

Bad: a formatter with no state or variation is wrapped in five layers and resolved through a service locator.
Good: a direct static/pure method, or the project's ordinary formatter object if framework conventions make that simpler.

Bad: a mutable `Money` object permits changing its currency without converting its amount.
Good: an immutable value object validates currency/amount together and exposes deliberate operations.

**Exception:** framework interfaces, proxies, and lifecycle hooks can be necessary. Name the framework requirement and retain the smallest structure that fulfills it; do not remove it based only on one implementation.

## Functional languages and functional application code

**Do:** use pure transformations, algebraic data types, opaque modules, and explicit effects to express invariants and boundaries.
**Do not:** simulate OOP with records of setters or force all effects through a custom abstraction framework.

Bad: a pricing function fetches the exchange rate, reads the clock, and mutates a shared cache while appearing to calculate a value.
Good: the application boundary fetches inputs; `price(order, rate, now)` calculates the result. Keep an existing effect system when it already expresses these needs clearly.

Bad: `status: string` plus unrelated nullable payload fields.
Good: a sum type with one valid payload per state and exhaustive pattern matching.

Why: explicit inputs and effects permit local reasoning; composition and substitution do not require inheritance.

**Exception:** tightly coupled effectful operations can stay together when their transaction or resource lifetime is the responsibility being protected. Purity is a means, not a demand for needless layers.

## C and procedural modules

**Do:** use cohesive translation units, opaque structs where invariants matter, explicit context parameters, and documented ownership/error results.
**Do not:** expose every mutable struct field to every caller or add function-pointer vtables to all small helpers.

Bad: callers reach into queue internals to edit head/tail pointers independently.
Good: the header exposes an opaque `Queue` and operations such as `queue_push`/`queue_pop`; implementation owns the representation and consistency checks.

Bad: a trivial checksum helper gets a polymorphic plugin ABI without a plugin requirement.
Good: a direct function with a length-aware input and a clear result contract.

**Exception:** plain structs suit transparent value records and performance-critical data layouts. State who owns memory and which code is allowed to mutate it; do not hide representation when that is the API's legitimate purpose.
