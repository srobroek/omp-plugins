# Go -- Sniff Reference

One-line scope: Go source -- `.go` files, `go.mod`, `go.sum`, Go modules.

## Detect

How sniff knows Go is present: a module manifest plus `.go` sources.
- Files/extensions: `*.go`; `go.mod` (module root); `go.sum`; `go.work` (multi-module workspace).
- Config that governs it: `.golangci.yml` / `.golangci.yaml` / `.golangci.toml` (which linters/thresholds are enabled -- respect it), `go.mod` `go` directive (language version gating some lint rules).

## Tools

The analyzers to run, primary first. golangci-lint is the meta-linter; it
collapses ~50 analyzers into one AST parse, so most dimensions need no extra tool.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| golangci-lint (primary) | From repo root: `golangci-lint run --output.json.path stdout --enable=gocyclo,gocognit,dupl,revive,unparam,gocritic,misspell ./...` (the `./...` walks the module -- no explicit paths). **NOTE:** v2 uses `--output.<fmt>.path`; if the installed version rejects `--output.json.path`, fall back to `--out-format json`. **Config:** honors `.golangci.yml`/`.yaml`/`.toml` if present -- `--enable` is ADDITIVE (it adds the smell linters on top, since defaults are only `errcheck`/`govet`/`ineffassign`/`staticcheck`/`unused`); when the repo already enables them in config, don't fight it. **Exit:** 1 = issues found (parse the JSON) · 0 = clean · any OTHER code = config/usage error → INVALID, fix and re-run (never report as clean). | complexity (gocyclo/gocognit), dup (dupl), dead code (unused), idioms (revive/gocritic), bugs (staticcheck), magic numbers (mnd), unchecked errors (errcheck), unused params (unparam), spelling (misspell) | default-on | `install-tools.sh --install go` |
| go vet | `go vet ./...` | built-in correctness checks (printf, struct tags, lock copying) | default-on | bundled with toolchain |
| deadcode | From repo root: `deadcode -json ./...` (whole-program reachability -- `./...` walks the module). Needs a BUILDABLE `main` to anchor reachability; a pure library yields fewer/no results (note that as a coverage limit, not "clean"). No config. **Exit:** 0 always (success doesn't signal findings) -- parse the emitted JSON list to determine findings; a build/usage failure (nonzero) is INVALID, fix and re-run. | whole-program reachability for unused functions -- `golangci`'s `unused` does NOT cover this | default-on | `install-tools.sh --install go` (`golang.org/x/tools/cmd/deadcode`) |
| staticcheck / gocyclo / gocognit (standalone) | Opt-in and **REDUNDANT** -- all three are already bundled in golangci-lint above, so normally do NOT run them separately (only if golangci-lint itself won't install/run). From repo root: `staticcheck ./...` / `gocyclo .` / `gocognit .` (staticcheck walks the module via `./...`; gocyclo/gocognit take a path). **Exit:** nonzero = findings present (parse stdout) · 0 = clean · usage/crash = INVALID. | bugs / cyclomatic + cognitive complexity, run individually | opt-in (redundant -- bundled in golangci-lint) | manual: `go install honnef.co/go/tools/cmd/staticcheck@latest` (and the gocyclo/gocognit cmds) |
| gosec | `gosec -fmt json ./...` | security issues (injection, weak crypto, file perms) | opt-in (security, not smell) | manual: `go install github.com/securego/gosec/v2/cmd/gosec@latest` |

Notes: golangci-lint is the single entry point -- it already wraps `go vet` and
makes **lizard and jscpd redundant for Go** (gocyclo/gocognit cover complexity,
`dupl` covers token duplication). **But its defaults are minimal** -- only
`errcheck`/`govet`/`ineffassign`/`staticcheck`/`unused` run out of the box, so the
smell linters sniff relies on (`gocyclo`, `gocognit`, `dupl`, `revive`,
`unparam`, `gocritic`, `misspell`) must be `--enable`d explicitly (unless the repo
already enables them in `.golangci.yml`). Respect `.golangci.yml`: if the project
disables a linter, do not re-flag what it intentionally suppresses. Always run
`deadcode` -- it does whole-program unreachable-function detection that golangci's
file-local `unused` linter does **not** cover; note the gap if it is not
installed. Running standalone `staticcheck`/`gocyclo`/`gocognit` or `gosec` is
opt-in: the first three are already bundled in golangci-lint (redundant), and
`gosec` is a security scanner rather than a smell detector.

## Smell checklist

Smells to look for beyond raw linter output. Each: what it looks like + the
idiomatic Go alternative. Go intentionally avoids deep abstraction -- keep fixes flat.

| Smell | What it looks like (Go) | Idiomatic alternative |
|-------|-------------------------|-----------------------|
| Unchecked error | `f, _ := os.Open(p)`; calling a fallible fn without checking `err` | Check `if err != nil`; errcheck flags it. Errors are values, handle them. |
| `panic` in library code | `panic(...)` in a reusable package instead of returning an error | Return `error`; reserve `panic` for truly unrecoverable programmer bugs. |
| Naked return in long fn | Named results with bare `return` far from the signature | Explicit `return a, b`; named returns OK only in tiny fns / for `defer` mutation. |
| Over-large interface | `interface{ ... }` with many methods defined next to the implementer | Small, consumer-defined interfaces (often 1 method); accept interfaces, return structs. |
| Premature interface | An interface with one implementation, defined by the producer | Use the concrete struct; add the interface at the consumer when a 2nd impl appears. |
| Ignored `context.Context` | A `ctx` param accepted then never passed down / never checked for cancellation | Thread `ctx` through call chain; honor `ctx.Done()` / pass to downstream calls. |
| Goroutine leak / missing timeout | `go f()` with no lifecycle owner; blocking channel/IO with no `ctx` or deadline | Bound with `ctx` + `context.WithTimeout`; ensure every goroutine has an exit path. |
| Stuttering name | `pkg.PkgThing`, `http.HTTPServer`, `user.UserService` | Drop the package prefix from the identifier -- `pkg.Thing`, `http.Server`. |
| Capitalized/punctuated error string | `errors.New("Failed to open.")` | Lowercase, no trailing punctuation: `errors.New("open config: %w")` style. |
| Mutable package-level state | Exported `var` mutated at runtime; shared globals | Pass dependencies explicitly; confine state to a struct the caller owns. |

## Idioms & style authorities

- Effective Go -- https://go.dev/doc/effective_go (naming, interfaces, errors, concurrency idioms).
- Go Code Review Comments -- https://go.dev/wiki/CodeReviewComments (the de-facto review checklist: error strings, naked returns, contexts, interfaces).
- Google Go Style Guide -- https://google.github.io/styleguide/go/ (style decisions + best-practices, the most prescriptive of the three).
- Key conventions to enforce:
  - Accept interfaces, return concrete structs.
  - Define interfaces where they are *consumed*, not where implemented; keep them small.
  - Wrap errors with `fmt.Errorf("...: %w", err)` to preserve the chain.
  - Error strings: lowercase, no trailing punctuation.
  - Avoid stuttering (`pkg.PkgThing`); name for the call site.
  - Always thread `context.Context` as the first parameter when crossing boundaries.

## refactoring.guru mappings

The generic OO catalog over-prescribes polymorphism and class extraction for Go;
the idiomatic fix is in the third column. Cite the smell URL, then the Go fix.

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Long parameter list | Long Parameter List (`/smells/long-parameter-list`) | Introduce Parameter Object as a config `struct`, or use the **functional-options idiom** (`func(*Opts)` variadics) -- the standard Go form, **not** a builder class. |
| `switch` / type-switch on a kind | Switch Statements (`/smells/switch-statements`) | **Do NOT push polymorphism.** Simple `switch` and `type switch` are idiomatic Go; only reach for an interface when behavior varies open-endedly across packages. |
| Large struct / god package | Large Class (`/smells/large-class`) | Extract Class → split into smaller types, or split the package by responsibility (Move Method/Field across files); Go organizes by package, not deep inheritance. |
| Duplicate code | Duplicate Code (`/smells/duplicate-code`) | Extract Method/function; share via a small interface or a helper -- **no** Pull Up Method (Go has no inheritance). `dupl` flags the candidates. |
| Long function | Long Method (`/smells/long-method`) | Extract Method (`/refactoring/techniques/composing-methods`) with early returns/guard clauses; flat is better than nested. |
| Unused func/var/import | Dead Code (`/smells/dead-code`) | Delete it; `unused` + `deadcode` flag it. Go's compiler already rejects unused imports/locals. |

## Pragmatism notes (for the adversarial pass)

Where "fixes" over-reach in Go -- the `refactor-challenger` should protect:

- Go intentionally avoids deep abstraction. Do **not** recommend Java-style patterns (abstract base classes, deep interface hierarchies, factories-of-factories). "Clear is better than clever."
- Small interfaces beat big ones -- flagging a project for "not enough abstraction" or "should extract an interface" when there's a single concrete type is usually wrong; premature interfaces are the real smell.
- Explicit `if err != nil` checks are idiomatic, **not** "boilerplate to remove." Do not propose macros, generics tricks, or panic-based control flow to eliminate them.
- A single-implementation concrete struct is fine and preferred; don't demand an interface "for testability" when the consumer doesn't need one.
- `switch` / type switches are idiomatic and should not be rewritten into polymorphism.
- Named returns and naked `return` are acceptable in short functions and where `defer` mutates the result -- only flag them in long functions.
- A linter disabled in `.golangci.yml` reflects a deliberate project choice; respect it rather than re-reporting the suppressed category.
