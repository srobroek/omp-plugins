# Vue (SFC components) -- Sniff Reference

One-line scope: Vue single-file components -- `.vue` files, Options & Composition
API, `<script setup>`. Base TS/JS language smells live in `./typescript.md`;
this doc covers component/composable smells only. Reference, don't duplicate,
typescript.md.

## Detect

How sniff knows Vue is present.
- Files/extensions: `.vue`; `vue` in `package.json` dependencies.
- Config that governs it: ESLint config with `eslint-plugin-vue`; `vue-tsc` /
  `tsconfig.json`; build config (`vite.config.*` with `@vitejs/plugin-vue`).

## Tools

Run `eslint-plugin-vue` first (the SFC meta-linter), then `vue-tsc` for
template-aware type checking that `tsc` alone cannot do.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| ESLint + `eslint-plugin-vue` | **An ESLint plugin, not a separate binary.** **Run:** ensure `eslint-plugin-vue` is in the repo's eslint config (it adds the `.vue` SFC parser + template rules), then the single `npx eslint --format json .` run executes it (file set = trailing `.`). **Config:** auto-uses the repo's eslint config -- no flag; if the plugin isn't configured, `.vue` files are skipped entirely (coverage gap -- note it). **Exit:** 0 = clean · **1 = lint errors → parse the JSON** · **2 = config/crash → INVALID.** **Gotcha:** needs `node_modules` present (`npm ci` in a fresh worktree). | template & SFC smells: `vue/require-v-for-key`, `vue/no-mutating-props`, `vue/no-use-v-if-with-v-for`, style-guide rules | default-on | `install-tools.sh --install js-ts` |
| `vue-tsc` | **Run:** `npx vue-tsc --noEmit` from the repo root (SFC-aware tsc wrapper -- type-checks `<template>` + `<script>`; **use this instead of plain `tsc`** for Vue projects). File set comes from the repo's tsconfig `include`. **Config:** the tsconfig governs; add `--strict` only if the tsconfig doesn't already. **Output:** text diagnostics on stderr (`file(line,col): error TSxxxx`), same format as tsc. **Exit:** 0 = clean · nonzero = type/template errors (parse them) · tsconfig-not-found / bad-flag = INVALID. **Gotcha:** needs deps installed -- `vue-tsc` resolves the `vue` + `@vue/*` decls and `@types/*`; a worktree without `npm ci` mis-reports missing modules. | type checking across `<template>` + `<script>` (props, emits, refs) -- replaces plain `tsc` for SFCs | default-on | `install-tools.sh --install js-ts` |
| stylelint + `stylelint-config-recommended-vue` | **`stylelint-config-recommended-vue` is a stylelint shareable config, not a separate binary** -- it teaches stylelint to extract the `<style>` block from `.vue` SFCs. **Run:** it rides the project's stylelint run -- `npx stylelint --formatter json "**/*.vue"` -- only when that config is in the repo's stylelint config; full stylelint recipe (exit codes, config handling, no-config fallback) is in `./css.md`, don't duplicate. **Gotcha:** if the config isn't extended, stylelint ignores `.vue` files silently. | SFC `<style>` block smells (specificity, `!important`, magic values) -- see `./css.md` | default-on when CSS-in-SFC | `npm i -D stylelint stylelint-config-recommended-vue` |

Notes: `eslint-plugin-vue` is the Vue meta-linter -- it parses the SFC and owns
template smells `tsc` cannot see. Use `vue-tsc` instead of plain `tsc` for Vue
projects: it understands `.vue` files and type-checks template expressions. When
SFCs carry `<style>` blocks, add `stylelint-config-recommended-vue` so stylelint
can lint the embedded CSS (default-on only when CSS-in-SFC is present; see
`./css.md` for the full CSS toolset). Base JS/TS complexity, dup, and dead-code
dimensions belong to `./typescript.md`; run those once per repo.

## Smell checklist

Component/composable smells beyond what tools flag.

| Smell | What it looks like (Vue) | Idiomatic alternative |
|-------|--------------------------|-----------------------|
| API style inconsistency | Some SFCs Options API, some Composition; mixed within one file | Pick one per project; prefer `<script setup>` for new code -- consistency, not migration for its own sake |
| Giant SFC | One `.vue` doing fetch + form + table + modal; huge `<script>`/`<template>` | Extract child components; extract logic into composables |
| `watch` that should be `computed` | A `watch` that only derives one value and assigns it to a ref | `computed(() => ...)` -- declarative, cached, no manual sync |
| Mutating props | Writing to `props.x` directly inside the child | Emit an event (`update:x`) / `defineModel`; treat props as read-only |
| Reactivity loss on destructure | `const { count } = reactive(state)` or destructuring `props` losing reactivity | `toRefs(state)` / `const { count } = toRefs(props)`; or access `props.count` directly |
| `v-for` without `:key` | `<li v-for="x in xs">` with no `:key` | `:key` bound to stable item identity |
| `v-if` + `v-for` on same element | `<li v-for="x in xs" v-if="x.ok">` (precedence trap, runs every item) | Filter in a `computed`, or move `v-if` to a wrapping `<template>` |
| Business logic in component | Fetching/validation/transforms inline in setup | Extract a composable (`useUsers()`) or plain module function |

## Idioms & style authorities

- Vue Style Guide: https://vuejs.org/style-guide/
- Composition API guide: https://vuejs.org/guide/extras/composition-api-faq.html
- Reactivity -- `<script setup>`: https://vuejs.org/api/sfc-script-setup.html
- Key conventions:
  - `computed` for derived values; reserve `watch` for side effects on change.
  - Composables (`use*`) are the unit of logic reuse, mirroring custom hooks.
  - `<script setup>` is the recommended authoring style for SFCs.
  - Always key `v-for`; never put `v-if` and `v-for` on the same element.
  - Props are one-way and read-only; communicate up via events / `defineModel`.

## refactoring.guru mappings

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Giant SFC | Large Class (`/smells/large-class`) | Extract Component / extract composable -- split template into children, lift logic into a `use*` composable |
| Duplicated logic across SFCs | Duplicate Code (`/smells/duplicate-code`) | Extract a shared composable (the Vue Extract Method) |
| `watch`-to-derive | Long Method (`/smells/long-method`) / Temporary Field | Replace with `computed` (Replace Temp with Query, declarative form) |
| Mutating props / two-way coupling | Inappropriate Intimacy (`/smells/inappropriate-intimacy`) | Change Bidirectional to Unidirectional -- emit events / `defineModel` |

Class-based catalog refactorings rarely apply; the Vue extraction units are the
component and the composable.

## Pragmatism notes (for the adversarial pass)

- Options API is a fully supported, valid style -- not a smell by itself. Flag
  *inconsistency* within a project, not Options API usage.
- Small components do not need composables. Extract a composable for reuse or
  testability, not by reflex.
- `watch` is correct when the reaction is a genuine side effect (fetch on id
  change, sync to localStorage) -- only flag `watch` that merely derives a value.
- Destructuring a `reactive`/`props` is fine when you immediately use the value
  and don't need it to stay reactive (e.g. reading a one-shot config).
- A single large but cohesive SFC that isn't reused isn't automatically a smell;
  split on diverging responsibility, not raw line count.
