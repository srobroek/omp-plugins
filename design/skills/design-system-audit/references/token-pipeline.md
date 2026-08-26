# Token engineering pipeline

## What is canonical, decided

Layered DTCG JSON under `tokens/**/*.json` is the canonical machine source. DESIGN.md is
the authored intent and rationale artifact, and a linted projection of that source. It is
NOT the compiler input.

The reason is concrete. `npx --yes @google/design.md export --format dtcg` is lossy three ways:
it resolves references into values rather than preserving the alias graph, it serialises
colours as sRGB component objects rather than the authored colour space, and it emits one
flat file with no component, theme, or density tiers. Closing that gap would need a
project-owned adapter, which this package does not ship and must not imply exists.

Use `export --format dtcg` for exactly one thing: bootstrapping a project that has no
tokens at all. Label it lossy when you do.

## The chain

```bash
# Gate the authored artifact. Exit 1 on errors. Safe with no --package because the spec
# names the scoped package: its bins are `design.md` and `designmd`, so they do NOT match.
npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"

# Independent DTCG schema gate. `--package` is REQUIRED: the bare bin name `dtokens`
# resolves an unrelated `dtokens` package on npm, not this one.
npx --yes --package=@design-token-kit/cli dtokens check --scope schema 'tokens/**/*.json'

# Build CSS custom properties, mode selectors, and typed JS. `--package` is REQUIRED:
# the bare name `tz` resolves the npm package `tz`, which ships no bin at all.
npx --yes --package=@terrazzo/cli tz build
```

Quote the glob. An unquoted `tokens/**/*.json` is expanded by the shell, not by the tool,
and the two disagree on recursion. Quote every substituted path for the opposite reason: a
literal `<repo>` is shell redirection. `skill://ui-review/references/tools.md` is the
authority on all three forms.

## One tool per job

| Job | Package and bin | Licence |
|---|---|---|
| Token build authority | `@terrazzo/cli` 2.7.1, bins `tz` and `terrazzo`, with `@terrazzo/plugin-css` and `@terrazzo/plugin-js` | MIT |
| Independent DTCG schema gate | `@design-token-kit/cli` 1.8.0, bin `dtokens` | Apache-2.0 |
| Colour and contrast maths | `colorjs.io` 0.7.1, no bin | MIT |
| DESIGN.md lint, diff, export | `@google/design.md` 0.4.0, bins `design.md` and `designmd` | Apache-2.0 |

Terrazzo is the build authority rather than Style Dictionary because it is DTCG-first,
models resolver contexts so theme and density map natively onto selectors such as
`[data-theme="dark"]`, emits a typed `.d.ts` whose `keyof Tokens` supplies the token-name
union, and performs CSS Color 4 gamut mapping.

Style Dictionary 5.5.2 (Apache-2.0) stays valid where a legacy Tokens Studio export or its
broader platform formats already dominate; add `@tokens-studio/sd-transforms` 2.0.3 (MIT)
and use `transformGroup: "tokens-studio"`. Never install both builders. Two engines means
two artifact authorities, and then neither is authoritative.

## Source format

DTCG Format Module 2025.10 is a Final Community Group Report and a W3C Candidate
Recommendation dated 28 October 2025. It is stable enough to pin as the source format. It
is NOT a W3C Standard; never call it one.

Author colours in the intended space and never pre-convert authored OKLCH to sRGB:

```json
{ "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.62, 0.16, 250], "alpha": 1 } }
```

## Eight techniques, and who owns each

| Technique | Owner |
|---|---|
| Tiered DTCG: `foundation.json`, `semantic.json`, `component/*.json`, `themes/*.json`, `density/*.json` | Project layering. Tier names are project convention, not spec semantics |
| Build CSS, never hand-edit it: `:root` properties, per-theme selectors, density classes, aliases preserved | `tz build` with `@terrazzo/plugin-css` |
| Generated token-name union so a bad name fails typecheck | `@terrazzo/plugin-js`; expose `keyof Tokens`. Never add a second TS generator |
| Drift gate: `--check` byte-compare per generated artifact | Project CI. No build engine replaces it |
| Theme completeness: every theme defines the full raw set, fallback selector asserted | Project policy. Terrazzo generates the matrix but asserts no requirement |
| Contrast gate at 4.5:1 body and 3:1 UI boundaries over generated pairs | Project script using `colorjs.io` `foreground.contrast(background, "WCAG21")`. It has no bin, so this script is project-owned |
| Every `var(--token)` resolves | Project CI over generated CSS. Catches serialisation and scope faults a source schema check cannot see |
| Raw hex and millisecond literals outside token files | Project CI. No schema validator duplicates this |

## One addition beyond the eight

A reachability gate, project-owned: find leaves unreachable from any public or component
token, and aliases with no consumer. No inspected tool exposes this, so it is glue and is
labelled as glue.

Fluid typography via `utopia-core` (ISC, no bin) is adopted ONLY when the product needs a
fluid scale. Otherwise reject it rather than adding a generator for its own sake.

## Runtime theming stays a browser concern

Apply `data-theme` alongside `prefers-color-scheme`, read a synchronous boot cache before
first paint, and verify with `skill://ui-review` computed styles. No build tool can prove
the absence of a flash or the correctness of cascade precedence; only driving the surface
can.

This package ships no cascade-origin route. `skill://ui-review` reads computed styles, which
answers what a property resolved to but never which rule won or where that rule lives. So
report an override you cannot attribute as unattributed, and name the property and selector
you measured.

Do NOT invent a route to close that gap. In particular, a command naming a relative path
such as `scripts/cdp.mjs` would run whatever the target repository happens to keep there.
