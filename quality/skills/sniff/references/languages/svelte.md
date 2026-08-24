# Svelte (components) -- Sniff Reference

One-line scope: Svelte components -- `.svelte` files, reactivity (legacy `$:` and
Svelte 5 runes), stores. Base TS/JS language smells live in `./typescript.md`;
this doc covers component/reactivity smells only. Reference, don't duplicate,
typescript.md.

## Detect

How sniff knows Svelte is present.
- Files/extensions: `.svelte`; `svelte` in `package.json`; `.svelte.ts`/
  `.svelte.js` rune modules (Svelte 5).
- Config that governs it: ESLint config with `eslint-plugin-svelte`;
  `svelte.config.js`; `tsconfig.json`; build (`vite.config.*` with
  `@sveltejs/vite-plugin-svelte`).

## Tools

Run `eslint-plugin-svelte` first, then `svelte-check` for compiler-level
template + type diagnostics ESLint does not produce.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| ESLint + `eslint-plugin-svelte` | **An ESLint plugin, not a separate binary.** **Run:** ensure `eslint-plugin-svelte` is in the repo's eslint config (it adds the `.svelte` parser + reactivity rules), then the single `npx eslint --format json .` run executes it (file set = trailing `.`). **Config:** auto-uses the repo's eslint config -- no flag; if the plugin isn't configured, `.svelte` files are skipped (coverage gap -- note it). **Exit:** 0 = clean · **1 = lint errors → parse the JSON** · **2 = config/crash → INVALID.** **Gotcha:** needs `node_modules` present (`npm ci` in a fresh worktree). | component smells: `svelte/require-each-key`, `svelte/no-reactive-reassign`, `svelte/no-dom-manipulating`, reactivity rules | default-on | `install-tools.sh --install js-ts` |
| `svelte-check` | **Run:** `npx svelte-check --output machine` from the repo root (the Svelte compiler's own diagnostic pass -- types + a11y + unused-CSS across markup that ESLint can't see). It discovers `.svelte` files via `svelte.config.js` + tsconfig; no path args. **Config:** `svelte.config.js`/tsconfig govern; `--output machine` gives the parseable line format (`ERROR`/`WARNING` rows) -- **parse the machine output**, not human text. **Exit:** 0 = no errors · nonzero = diagnostics (parse the machine rows) · a config-load/crash error = INVALID. **Gotcha:** needs deps installed -- it loads the svelte compiler + language tools and resolves `@types/*`; a worktree without `npm ci` mis-reports. | compiler diagnostics + TS across markup, missing keys, unused props, a11y warnings | default-on | `install-tools.sh --install js-ts` |

Notes: `eslint-plugin-svelte` is the Svelte meta-linter (parses `.svelte`).
`svelte-check` is the compiler's own diagnostic pass -- it surfaces template/type
errors plus accessibility warnings ESLint cannot. Use `--output machine` for
parseable output. Base JS/TS complexity, dup, and dead-code dimensions belong to
`./typescript.md`.

## Smell checklist

Component/reactivity smells beyond what tools flag. Note the Svelte 5 runes
(`$state`/`$derived`/`$effect`) vs legacy (`$:`, `export let`, writable refs)
split -- flag *mixing* the two reactivity models in one component.

| Smell | What it looks like (Svelte) | Idiomatic alternative |
|-------|-----------------------------|-----------------------|
| Store where local state suffices | `writable(0)` for a counter used only inside one component | Local `let` (legacy) or `$state` (runes) -- stores are for *cross-component* shared state |
| Missing reactive declaration | Manually recomputing a value in handlers instead of deriving it | `$: doubled = count * 2` (legacy) or `$derived(count * 2)` (runes) |
| Mixing runes and legacy reactivity | `$:` reactive statements alongside `$state`/`$derived` in one component | Commit to one model per component (runes for Svelte 5 code) |
| Unnecessary reactivity | `$:` / `$effect` wrapping work that runs once or belongs in an event handler | Plain statement in setup, or do it in the `on:click` handler |
| Logic that belongs in a module | Data fetching / transforms / parsing inline in `<script>` | Extract to a `.ts`/`.svelte.ts` module function; import it |
| Mutating props | Reassigning an `export let` prop / a `$props()` value in the child | Use `bind:` from the parent, or emit/callback; treat props as inputs |
| Missing `{#each}` key | `{#each items as item}` with no `(item.id)` on a dynamic list | `{#each items as item (item.id)}` |
| Large component | One `.svelte` with markup + heavy `<script>` + many responsibilities | Extract child components; move logic to modules |

## Idioms & style authorities

- Svelte docs: https://svelte.dev/docs
- Runes (`$state`/`$derived`/`$effect`): https://svelte.dev/docs/svelte/what-are-runes
- Stores: https://svelte.dev/docs/svelte/stores
- Key conventions:
  - Prefer derived reactivity (`$:` / `$derived`) over manual recomputation.
  - Stores are for state shared *across* components; local state stays local.
  - `$effect` (runes) / `$:` side-effect blocks are for synchronizing with
    external systems -- not for deriving values.
  - Key every dynamic `{#each}`.
  - In Svelte 5 code, use runes; don't interleave legacy reactivity.

## refactoring.guru mappings

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Large component | Large Class (`/smells/large-class`) | Extract Component -- split markup into children, move logic to modules (not Extract Class) |
| Duplicated logic across components | Duplicate Code (`/smells/duplicate-code`) | Extract a shared module function or store (the Svelte Extract Method) |
| Manual recompute instead of derive | Long Method (`/smells/long-method`) / Temporary Field | Replace Temp with Query → `$derived` / `$:` |
| Store for purely local state | Speculative Generality (`/smells/speculative-generality`) | Inline to local `$state`/`let` |

Svelte's extraction units are the component and the plain module, not the class.

## Pragmatism notes (for the adversarial pass)

- Svelte's reactivity is implicit by design. Concise, "magic"-looking reactive
  code is idiomatic -- don't flag terseness as a smell.
- Small components are idiomatic; Svelte's whole point is low ceremony. Don't
  push module extraction onto a tiny component.
- A single `writable` shared by two sibling components is correct store usage --
  only flag stores backing state that never leaves one component.
- A legacy-reactivity (`$:`) codebase that hasn't migrated to runes is valid;
  flag *mixing* within a component, not the absence of a runes migration.
- `$effect` / `$:` side effects are legitimate when synchronizing with the DOM,
  storage, or subscriptions -- only flag effects that merely derive a value.
