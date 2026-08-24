# Rust -- Sniff Reference

One-line scope: Rust source -- `.rs` files, `Cargo.toml`, `Cargo.lock`, workspaces.

## Detect

How sniff knows Rust is present: a Cargo manifest plus `.rs` sources.
- Files/extensions: `*.rs`; `Cargo.toml` (package or `[workspace]`); `Cargo.lock`.
- Config that governs it: `clippy.toml` / `.clippy.toml` (lint thresholds), `rustfmt.toml` / `.rustfmt.toml` (formatting), `[lints]` table in `Cargo.toml`, `rust-toolchain.toml` (pins channel; tells you whether nightly tools are usable).

## Tools

The analyzers to run, primary first. Rust's standard toolchain covers nearly
every dimension through clippy; resist stacking cross-language tools.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| clippy (primary) | From repo root: `cargo clippy --message-format=json` (covers the whole workspace; clippy resolves the package set itself -- no explicit paths). **Config:** if the repo pins `[lints.clippy]` (in `Cargo.toml`) or ships `clippy.toml`/`.clippy.toml`, run AS-IS with NO extra flags (it already raised the bar; forcing flags re-floods it with findings it deliberately allows). **No-config fallback only:** append `-- -W clippy::pedantic -W clippy::nursery`. Add `--all-features` if any in-scope file is behind `#[cfg(feature = ...)]` (otherwise that code is silently unlinted) and **report which features were enabled**. **Exit:** parse the JSON `message` records; IGNORE the exit status (nonzero on warnings is normal, not a crash). **Gotcha:** clippy emits diagnostics only when it actually RECOMPILES -- a sub-second run with empty output means nothing recompiled (warm `target/` cache), which is INVALID, NOT clean → force a real compile (`cargo clean -p <crate>` or `touch` the in-scope sources) and re-run. | idioms, complexity, dead code, perf, footguns -- nearly all | default-on | `install-tools.sh --install rust` (rustup component) |
| cargo-machete | From repo root: `cargo machete` (manifest-level -- reads `Cargo.toml`, no build, fast; no explicit paths or output flag needed -- output is a plain per-crate list). No config. **Exit:** 0 = no unused deps (clean) · nonzero = unused declared deps found (parse the listed crate names) · usage/crash = INVALID. | unused declared dependencies (fast, manifest-level) | default-on | `install-tools.sh --install rust` |
| rustc lints | **No separate run** -- `dead_code`/`unused_variables`/`unreachable` and other compiler `warning` diagnostics are emitted implicitly under clippy's own build and already appear in clippy's `--message-format=json` stream (parse them there). Only run `cargo build --message-format=json` standalone if you deliberately skipped clippy; same JSON `message` parsing, same ignore-exit-status rule. | dead_code, unused_variables, unreachable, type-level issues clippy may not duplicate | default-on (implicit -- runs under clippy's own compile) | bundled with toolchain |
| cargo-udeps (nightly) | Opt-in only. From repo root: `cargo +nightly udeps --output json` -- REQUIRES the nightly toolchain (`+nightly`) AND a full build (slow); skip with a noted gap if `rust-toolchain.toml` pins stable and nightly is unavailable (`cargo machete` is the stable fallback). No config. **Exit:** parse the JSON output for unused-dep entries; treat a usage/crash (missing nightly) as INVALID, not clean. | compiler-accurate unused deps; deep runs only | opt-in (nightly + full build; machete covers it) | manual: `cargo install cargo-udeps` (not in a bundle) |
| cargo-geiger | `cargo geiger --output-format Json` | `unsafe` usage footprint across the dep tree | opt-in (unsafe-footprint audit, not general smell) | manual: `cargo install cargo-geiger` (not in a bundle) |

Notes: clippy is the meta-linter -- it is rustc-integrated and type/MIR aware, so
it subsumes the complexity, dup, dead-code, and idiom dimensions other languages
need point tools for. **Run project-config clippy first; only add
`-W pedantic`/`-W nursery` when the repo configures no clippy lints** (no
`[lints.clippy]` table in `Cargo.toml`, no `clippy.toml`). Forcing those flags on
a repo that already curates its clippy config overrides the Hard Rule and buries
real findings under opinionated noise the maintainer chose to allow.

**Two clippy gotchas that produce a FALSE "clean" -- both must be handled:**

1. **Warm build cache → empty stream that is not clean.** clippy only emits JSON
   diagnostics when it actually recompiles. With a warm `target/`, a re-run
   finishes in well under a second, recompiles nothing, and emits **zero**
   diagnostic records -- which a naive reader takes as "0 findings, clean." Rule:
   a sub-second clippy run that emits zero JSON records is **INVALID, not clean**.
   Force a real compile first (`cargo clean -p <crate>`, or `touch` the in-scope
   sources) and re-run; only an empty stream from a run that actually compiled
   means clean.
2. **Feature-gated code is silently unlinted.** Bare `cargo clippy` won't compile
   `#[cfg(feature = "...")]` code, so any in-scope file behind a non-default
   feature is never checked, with no warning. If the resolved file set contains
   `#[cfg(feature = ...)]` files, detect the gating features from `Cargo.toml`
   and run with `--all-features` (or the specific `--features X`); **report which
   features were enabled**, so the coverage note is honest about what was linted.
**Do NOT install lizard or jscpd for Rust**: clippy's
`cognitive_complexity`, `too_many_lines`, and `too_many_arguments` cover
complexity, and there is no idiomatic token-dup story worth a separate tool
(cross-crate exact-file duplication is the one exception -- see Pragmatism notes).
cargo-udeps needs nightly -- skip it (and note the gap) if `rust-toolchain.toml`
pins stable and nightly is unavailable; `cargo machete` is the stable fallback.
Rust has **no native duplication detector** -- the cross-language `jscpd`/`lizard`
tools cover that dimension when cross-crate exact-file duplication matters.

## Smell checklist

Smells to look for beyond raw clippy output (clippy flags most, but intent-level
ones below need judgment). Each: what it looks like + the idiomatic alternative.

| Smell | What it looks like (Rust) | Idiomatic alternative |
|-------|---------------------------|-----------------------|
| Needless clone/borrow | `.clone()` to satisfy the borrow checker; `&Vec<T>` params; `x.to_owned()` then read-only use | Borrow (`&[T]`, `&str`), restructure lifetimes; clippy `redundant_clone`, `ptr_arg` |
| `unwrap`/`expect` in library code | `.unwrap()` / `.expect(..)` on `Result`/`Option` in non-test, non-`main` code | Return `Result`, propagate with `?`; reserve `expect` for documented invariants |
| Stringly-typed API | `fn set_mode(&str)`, status as `String`, flags as bare `bool`/`u8` | `enum` for closed sets; newtype (`struct UserId(u64)`) for identifiers |
| Oversized fn | One `fn` doing parse + validate + execute; clippy `too_many_lines` | Extract Method into named helpers; small fns are idiomatic |
| Missing `?` propagation | `match res { Ok(v) => v, Err(e) => return Err(e.into()) }` boilerplate | `let v = res?;`; add `From` impls / `thiserror` for conversion |
| `impl Trait` overuse | `impl Trait` in struct fields, or where a named type/`dyn` reads clearer | Name the concrete type, or `Box<dyn Trait>` for heterogeneous storage |
| Premature trait for single impl | A `trait Foo` with exactly one `impl` and no second caller in sight | Use the concrete type directly; introduce the trait when the 2nd impl arrives |
| Manual loop where adapter fits | `for` loop pushing into a `Vec`, manual index walking, accumulator flags | Iterator adapters (`map`/`filter`/`collect`/`fold`); clippy `needless_range_loop`, `manual_map` |
| `as` cast / manual deref conversion | `x as u64`, lossy `as` casts, hand-written deref-and-convert | `From`/`TryFrom` / `TryInto`; `u64::from(x)`; clippy `cast_possible_truncation` (pedantic) |
| Match arm explosion on type code | `match self.kind { 0 => .., 1 => .. }` over integer/string discriminants | Replace the discriminant with an `enum` and match on its variants |

## Idioms & style authorities

- Rust API Guidelines -- https://rust-lang.github.io/api-guidelines/ (the C-* checklist: naming, `From`/`TryFrom`, error types, `#[non_exhaustive]`).
- Rust Style Guide -- https://doc.rust-lang.org/nightly/style-guide/ (formatting baseline; enforced by `rustfmt`).
- Clippy lint documentation -- https://rust-lang.github.io/rust-clippy/ (per-lint rationale; cite the lint name in findings).
- Key conventions to enforce:
  - Prefer `enum` + exhaustive `match` over a State/Strategy object hierarchy.
  - Newtypes over primitive obsession (`struct Meters(f64)`, `struct UserId(u64)`).
  - `?` operator over hand-rolled try/catch shapes; conversion via `From`/`thiserror`.
  - Builder pattern only when a type has many optional fields -- not for 2 to 3 args.
  - Accept slices (`&str`, `&[T]`); name getters without `get_` (API Guidelines C-GETTER).

## refactoring.guru mappings

The generic OO catalog frequently mis-prescribes for Rust; the idiomatic fix is
in the third column. Cite the smell URL, then the Rust-correct refactoring.

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Stringly-typed / bool / int flags | Primitive Obsession (`/smells/primitive-obsession`) | Newtype or `enum` -- **NOT** a class. Replace Data Value with Object → a newtype `struct`; Replace Type Code → an `enum`. |
| Oversized `fn` | Long Method (`/smells/long-method`) | Extract Method (`/refactoring/techniques/composing-methods`) into private helpers; idiomatic Rust favors many small fns. |
| `match`/`if` on a type code | Switch Statements (`/smells/switch-statements`) | **Do NOT reflexively recommend polymorphism.** Exhaustive `match` on an `enum` is the idiomatic Rust form; only reach for `dyn Trait` when behavior, not data, varies open-endedly. |
| Long parameter list | Long Parameter List (`/smells/long-parameter-list`) | Introduce Parameter Object as a plain `struct`; for many *optional* fields, a builder. |
| Duplicate code across impls | Duplicate Code (`/smells/duplicate-code`) | Extract Method, or a shared `trait` with a default method (Form Template Method) when a real second impl exists. |
| Unused fn/field/variant | Dead Code (`/smells/dead-code`) | Delete it; rustc `dead_code` + clippy already flag it. Don't keep "for later." |

## Pragmatism notes (for the adversarial pass)

Where "fixes" over-reach in Rust -- the `refactor-challenger` should protect:

- A trait with a single impl is fine; don't demand a second impl just to justify abstraction. Premature trait extraction is the more common real smell.
- `.clone()` in a non-hot path (setup, config load, error path, tests) is fine -- readability beats a borrow-checker puzzle. Only flag clones in measured hot loops.
- "Too many small functions" is rarely a real smell in Rust -- small, named fns are idiomatic and the compiler inlines them. Do not consolidate them into one big fn.
- `unwrap`/`expect` is acceptable in `main`, tests, build scripts, and after a checked invariant with a documented `expect` message. Reserve the finding for library/reusable code.
- `match` is not a "switch smell." Recommending polymorphism to replace an exhaustive `enum` match is an anti-pattern in Rust and almost always wrong.
- `pedantic`/`nursery` lints are advisory and noisy by design -- treat them as candidates, not failures, and defer to a project's `clippy.toml` / `[lints]` allow-list.
- A `#[non_exhaustive]` enum legitimately forces a wildcard arm -- that wildcard is not a missing-case smell.
- **FFI/macro boundary false positives.** On `#[napi]` (napi-rs) and `#[pymethods]`/`#[pyfunction]` (PyO3) fns, clippy `needless_pass_by_value` fires on `String`/`serde_json::Value`/`Value` params that "aren't moved in the body" -- but the macro-generated glue decodes the JS/Python arg into that owned value and owns it; switching to `&str`/`&Value` changes the marshaling and the **published binding signature**. This is a known false positive -- do NOT "take by reference" at an FFI boundary. Same caution for any lint that judges a signature the macro, not the visible body, controls.
- `option_if_let_else` / `single_match_else` (nursery) suggest `Option`/`Result` combinators over `match`/`if let`. When an arm carries logic or an explanatory/security comment, the `match` is *more* readable -- Rust favors `match` once arms do more than rename a value. Don't collapse a commented match into a `map_or_else` closure.
