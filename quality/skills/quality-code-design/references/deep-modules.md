# Deep modules and seams

Read when designing or deepening a module's interface, choosing where a seam goes, or
making code more testable. Encapsulation and composition basics are in
[encapsulation.md](encapsulation.md).

## Vocabulary

- **Module:** anything with an interface and an implementation, at any scale: a function,
  class, package, or tier-spanning slice.
- **Interface:** everything a caller must know to use the module correctly: types, and
  also invariants, ordering constraints, error modes, required configuration, and
  performance characteristics.
- **Depth:** behavior per unit of interface a caller learns. A module is **deep** when a
  large amount of behavior sits behind a small interface, **shallow** when the interface
  is nearly as complex as the implementation.
- **Seam:** a place where behavior can be altered without editing in that place; the
  location at which a module's interface lives. Choosing it is a design decision of its own.
- **Adapter:** a concrete thing that satisfies an interface at a seam.
- **Leverage** is what callers gain from depth; **locality** is what maintainers gain:
  change, bugs, and knowledge concentrate in one place instead of across callers.

## Principles

- Depth is a property of the interface. A deep module can be built from small, swappable
  parts that are not part of its interface; it may have internal seams for its own tests.
  Do not expose an internal seam through the interface just because tests use it.
- Deletion test: imagine deleting the module. If complexity vanishes, it was a
  pass-through. If complexity reappears across many callers, it earned its keep.
- The interface is the test surface. Callers and tests cross the same seam; a test that
  must reach past the interface signals the wrong module shape.
- When designing an interface, ask whether methods can be fewer, parameters simpler, and
  more complexity hidden inside.

## The seam rule

Introduce a seam (interface, trait, callback, or port) where something varies across it
now or a real boundary needs protecting: a second adapter in use (a test adapter counts),
a remote or external system, or a dependency whose types must not leak into callers. A
seam with one adapter and no such boundary is indirection: call the implementation
directly. Implementation count alone decides neither way.

## Deepening a cluster of shallow modules

Classify each dependency first; the category decides how the deepened module is tested.

| Dependency → test approach | Seam |
|---|---|
| In-process: pure computation, in-memory state, no I/O → merge the modules and test through the new interface | none needed |
| Local-substitutable: has a local stand-in (PGLite for Postgres, an in-memory filesystem) → run the stand-in in the test suite | internal |
| Remote but owned: your own services across a network → define a port at the seam; production uses an HTTP/gRPC/queue adapter, tests an in-memory adapter | port |
| True external: third-party services you do not control → inject the port; tests use a mock adapter | port |

Replace, do not layer: write tests at the deepened module's interface, asserting
observable outcomes rather than internal state. Before deleting the old unit tests on the
shallow modules, port every edge case they cover to the new interface tests; delete an old
test only once its cases pass there.

## Design it twice (optional)

Run this only when the user asks to explore alternative interfaces. State the
constraints, dependencies (with their category), and a rough code sketch, then produce
two to four radically different interfaces, for example: minimal entry points;
maximum flexibility; the commonest caller made trivial; ports and adapters across seams.
Parallel sub-agents may draft them within the delegation limits. For each, give the
interface, a usage example, what it hides, its dependency strategy, and its trade-offs.
Compare on depth, locality, and seam placement, then recommend one or a hybrid.
