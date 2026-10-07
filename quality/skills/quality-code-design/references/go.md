# Go: conditional language guidance

Load only when the task designs, investigates, changes, or reviews Go code. Do not impose Java-style hierarchies on Go.

Language reference: [Effective Go](https://go.dev/doc/effective_go) for core idioms; use the project's Go version documentation for newer language features.

## Consumer-owned interfaces and concrete implementations

**Do:** use small interfaces at actual consumer boundaries; return concrete types when callers benefit from their concrete API.
**Do not:** define an interface beside every struct automatically or build a DI framework to pass two dependencies.

Bad:

```go
type UserServiceInterface interface {
    Find(context.Context, string) (User, error)
    Delete(context.Context, string) error
    ExportBilling(context.Context) ([]byte, error)
}
// A profile renderer now requires unrelated capabilities.
```

Good, in the consuming package:

```go
type UserFinder interface {
    Find(context.Context, string) (User, error)
}
type Profile struct { users UserFinder }
func NewProfile(users UserFinder) *Profile { return &Profile{users: users} }
```

Why: implicit satisfaction lets an adapter meet the consumer's contract without coupling the provider to it. One implementation can justify the boundary; interface count is not a quality metric.

**Exception:** a pure function or local concrete helper needs no interface. A shared protocol can own an interface when it has coherent cross-consumer semantics; do not duplicate identical contracts as a ritual.

## Structs, methods, privacy, and composition

**Do:** keep invariant-bearing fields unexported and use methods for valid transitions. Use explicit fields for composition unless embedding's promoted API is intentional.
**Do not:** embed for accidental inheritance or return mutable internals without an ownership decision.

Bad:

```go
type Queue struct { Items []Job }
// Callers can replace the backing slice and bypass scheduling invariants.
```

Good:

```go
type Queue struct { items []Job }
func (q *Queue) Snapshot() []Job { return append([]Job(nil), q.items...) }
// Enqueue validates the job and owns the mutation.
```

Why: the slice backing array is no longer shared by the snapshot. If Job contains pointers or maps, copy or make those values immutable too. Define whether concurrent access is supported; private fields alone do not make it safe.

**Exception:** exported structs suit plain data and configuration without hidden lifecycle invariants. Preserve useful zero values when possible; use constructors when valid initialization requires validation or resources.

## Packages, errors, and contract preservation

**Do:** organize packages by coherent responsibility, keep dependencies acyclic, accept cancellation where I/O needs it, and preserve meaningful errors.
**Do not:** create a catch-all `utils` package, hide request context in global state, or replace errors with success-shaped zero values.

Bad:

```go
user, _ := store.Find(ctx, id)
return user // missing and unavailable become indistinguishable
```

Good:

```go
user, err := store.Find(ctx, id)
if err != nil { return User{}, fmt.Errorf("find user: %w", err) }
return user, nil
```

Why: wrapped errors preserve inspection with `errors.Is`/`errors.As`. The boundary still needs to define not-found semantics and whether concrete provider errors cross it.

**Exception:** translate infrastructure errors into domain errors at a boundary when callers should not depend on the provider. Preserve diagnostic context without making implementation details part of the domain contract.

## Keep small Go tools small

Bad: `CommandFactory`, `RunnerProvider`, and a generic repository for a CLI that reads one file and writes one report.
Good: parse flags in `main`, call one transformation function, and handle I/O errors at the edge. Add a package when a coherent responsibility actually needs separation.

**Do:** revisit this structure as behavior grows.
**Do not:** equate one consumer with "no useful boundary," or multiple files with maintainability.

**Exception:** an established CLI framework can reduce present flag/subcommand complexity. Use its ordinary conventions without inventing a second framework around it.
