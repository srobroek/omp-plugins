# TypeScript / JavaScript -- Sniff Reference

One-line scope: non-framework TS/JS source -- `.ts`, `.tsx`, `.mts`, `.cts`,
`.js`, `.jsx`, `.mjs`, `.cjs`. React/Vue/Svelte have their own docs; this covers
plain modules, Node services, and libraries.

## Detect

How sniff knows this language/format is present: key files, extensions, config.
- Files/extensions: `.ts` / `.tsx` / `.mts` / `.cts`, `.js` / `.jsx` / `.mjs` /
  `.cjs`; `package.json`; `tsconfig.json` / `jsconfig.json`.
- Config that governs it: `eslint.config.{js,mjs,cjs,ts}` (flat config) or
  legacy `.eslintrc.{js,cjs,json,yml}`; `tsconfig.json` (`compilerOptions`,
  esp. `strict`); `biome.json` / `biome.jsonc`; `knip.json` / `knip.ts`.
  Respect these -- do not override the project's lint/strictness settings.

## Tools

The analyzers to run, primary first. Exact invocation + machine-readable flag.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| ESLint + typescript-eslint | **Run:** `npx eslint --format json .` (file set = the trailing `.`; eslint walks the repo per its `ignores`). **Config:** auto-uses the repo's flat/legacy config -- no flag. Type-aware rules (`no-floating-promises`, `no-unsafe-*`) only fire if that config enables the **type-checked tier** (`recommendedTypeChecked`/`strictTypeChecked`) *and* points `parserOptions.project` at a tsconfig; if it does neither, those any-leakage smells are **out of scope** -- note the gap, don't pass extra flags to force them. **Exit:** 0 = clean · **1 = lint errors found → parse the JSON** · **2 = config load / parse / crash → INVALID** (fix, don't report as clean). **Gotcha:** needs the repo's `node_modules` present; a fresh worktree must `npm ci` first or every run is INVALID. | idioms, complexity, bugs, dup; type-aware rules `no-floating-promises`, `no-unsafe-*` (any-leakage at rule level) | default-on | project-local (`package.json`); `install-tools.sh --install js-ts` provisions globally if absent |
| eslint-plugin-sonarjs | **Not a separate binary** -- an ESLint plugin. **Run:** ensure it's in the repo's eslint config, then the single `npx eslint --format json .` run above already executes its rules; no extra invocation. Same exit-code contract as that run. | cognitive complexity, duplicated branches, identical conditions | default-on | `npm i -D eslint-plugin-sonarjs` |
| eslint-plugin-unicorn | **Not a separate binary** -- an ESLint plugin. **Run:** ensure it's in the repo's eslint config, then the single `npx eslint --format json .` run above covers it; no extra invocation. Same exit-code contract as that run. | modernization (prefer `node:` protocol, top-level await, `Array#flatMap`) | default-on | `npm i -D eslint-plugin-unicorn` |
| tsc | **Run:** `npx tsc --noEmit -p <tsconfig>` (point `-p` at the repo's tsconfig so its `include`/`paths` select the file set; add `--strict` only if the repo's tsconfig does *not* already set it -- honor the project's strictness, don't force-tighten). **Config:** the tsconfig is the config; `-p` selects it. **Output:** parse the diagnostics on **stderr** (no JSON formatter -- text `file(line,col): error TSxxxx`). **Exit:** 0 = no type errors · nonzero = type errors emitted (parse them) · a tsconfig-not-found / bad-flag failure = INVALID. **Gotcha:** needs deps installed (resolves `@types/*` and imported decls); a worktree without `npm ci` reports phantom "cannot find module" errors. | type smells (`any` leakage, missing null checks) | default-on | project-local TypeScript |
| knip | **Run:** `npx knip --reporter json` (no path args -- knip resolves its own entry/project file set from `knip.json`/`knip.ts` or, absent that, `package.json` + tsconfig). **Config:** auto-uses `knip.json`/`knip.{ts,js}` if present; otherwise its zero-config heuristics -- no flag. **Exit:** 0 = nothing unused · **nonzero = findings present → parse the JSON** · a config/crash error = INVALID. **Gotcha:** needs deps installed (it walks the real dep graph); without `npm ci` it over-reports unused deps. Global-class tool -- whole-repo only, skip in scoped mode. | dead files, unused exports, unused deps | default-on | `npm i -D knip` |
| dependency-cruiser | **Run:** `npx depcruise --output-type json src` (file set = the repo's source dir as the trailing arg -- swap `src` for the repo's actual source root). For **cycles only**, use `--output-type err`. **Config:** if `.dependency-cruiser.{js,cjs,json}` exists it is auto-used (it carries the project's boundary rules); only add `--no-config` when there is none and you just want the built-in cycle detection. **Exit:** 0 = no violations · nonzero = rule violations (parse the JSON) · a config/parse error = INVALID. **Gotcha:** point it at the real source dir, not `.` (scanning `node_modules`/build output yields noise). Global-class -- whole-repo only, skip in scoped mode. | circular dependencies, barrel cycles, architecture/boundary violations | default-on | `npm i -D dependency-cruiser` |
| type-coverage | **Run:** `npx type-coverage --detail --strict` from the repo root (no path args -- it reads the repo's tsconfig to pick the file set; `--detail` lists every `any`-site by `file:line`, `--strict` counts type-arg `any`s too). **Config:** the tsconfig governs; no flag. **Output:** a coverage **percentage** plus the `--detail` any-site list (not JSON). **Exit:** exits nonzero only if you pass `--at-least <pct>` and the repo falls below it; with no threshold it exits 0 -- so read the **reported %**, never infer cleanliness from the exit code. A tsconfig/crash error = INVALID. **Gotcha:** needs deps installed (resolves types). | percent of code that is implicitly/explicitly `any` | default-on | `npm i -D type-coverage` |
| madge | **Run (opt-in):** `npx madge --circular --json <src>` (file set = the repo's source dir as the trailing arg; `--circular` restricts output to cycles, `--json` makes it parseable). **Config:** honors `.madgerc` if present; else defaults. **Exit:** with `--circular`, exits **1 when cycles are found**, 0 when none -- parse the JSON for the cycle list; a usage/parse error = INVALID. **Gotcha:** lighter cycles-only fallback -- only run when dependency-cruiser is absent. | circular dependencies, barrel cycles | opt-in (redundant w/ dependency-cruiser; lighter cycles-only fallback) | `npm i -D madge` |
| biome | **Run (opt-in):** `npx biome lint --reporter=json <paths>` (file set = explicit paths, e.g. `src` or `.`). **Config:** auto-uses `biome.json`/`biome.jsonc` if present; else built-in defaults -- no flag. **Exit:** 0 = clean · nonzero = diagnostics found (parse the JSON) · a config/usage error = INVALID. **Gotcha:** alternative to ESLint, not an addition -- only run when the repo uses biome instead of eslint; it has no type-aware rules (no `any`-leakage coverage). | fast linter+formatter alternative (also JSON) | opt-in (alternative to ESLint, not an addition; no type-aware rules) | `npm i -D @biomejs/biome` |

Notes: ESLint with `typescript-eslint` is the meta-linter -- it parses once and
runs all rules. Enable the **type-checked tier** (`recommendedTypeChecked` or
`strictTypeChecked`), not just `recommended`: that is what turns on
`no-floating-promises` and the `no-unsafe-*` family (any-leakage caught at the
rule level). **eslint-plugin-sonarjs makes `lizard` and `jscpd` redundant for
TS/JS** (it covers cognitive complexity and duplicated branches in-tree). Run
`tsc --noEmit` only against a real `tsconfig.json`; without one, type smells are
out of scope. `dependency-cruiser` is the default-on structural tool -- it covers
both cycles and architecture/boundary rules, **superseding `madge`** (orphans +
boundaries); keep `madge` only as a lighter cycles-only fallback. `biome` is an
*alternative* to ESLint, not an addition -- if the project already uses ESLint,
prefer it (richer type-aware rules). `ts-prune` is **DEPRECATED → use `knip`**
(do not add it). Use `dependency-cruiser` and `knip` for structural smells
ESLint cannot see (cycles, boundaries, dead files).

## Smell checklist

The smells to look for, beyond what tools flag. Each: what it looks like + the
idiomatic alternative. Be language-specific.

| Smell | What it looks like (this language) | Idiomatic alternative |
|-------|-----------------------------------|-----------------------|
| `any` escape hatch | `: any`, `function f(x: any)`, implicit `any` params | `unknown` + narrowing; a real interface/type; `zod`/`valibot` at boundaries |
| Unsafe cast / `as` assertion | `data as Foo`, double-cast `x as unknown as Foo` | parse & validate (`zod.parse`), type guard `x is Foo`, discriminated narrowing |
| Non-null `!` overuse | `obj!.prop!.value`, `el!.click()` | optional chaining `?.`, explicit guard, `assert`/invariant with a message |
| Stringly-typed state | `status: string` with `if (status === "ok")` everywhere | discriminated union `{ kind: "ok" } \| { kind: "err"; msg: string }` |
| Enum misuse | numeric `enum` leaking values, `const enum` across module boundaries | string-literal union `type X = "a" \| "b"` or `as const` object |
| Missing `await` / floating promise | `doAsync()` with no `await`/`.catch`, nested `.then().then()` | `await`, `Promise.all`, async/await flattening; enable `no-floating-promises` |
| Callback hell | deeply nested callbacks for sequential async | promisify + `async`/`await` |
| Barrel-file cycle | `index.ts` re-exporting modules that import the barrel | import from concrete modules; break the cycle (`madge --circular`) |
| God module | one file exporting dozens of unrelated functions | split by responsibility (Extract Class/module) |
| Loose equality | `==` / `!=` (type coercion bugs) | `===` / `!==` (`eqeqeq` rule) |
| Shared-state mutation | mutating exported objects/arrays, push to module-level cache | `readonly`, return new values, encapsulate behind functions |
| Untyped JSON boundary | `JSON.parse(body)` typed as `any`/cast to a type | parse with `zod`/`valibot`; type the validated result |
| Default-export inconsistency | mix of `export default` and named in one codebase | pick one (named exports aid tree-shaking & refactors) |

## Idioms & style authorities

- typescript-eslint `recommended-type-checked` (and `strict-type-checked`) --
  https://typescript-eslint.io/users/configs/ -- the baseline rule set to enable.
- TypeScript Handbook "Do's and Don'ts" --
  https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html
- Google TypeScript Style Guide -- https://google.github.io/styleguide/tsguide.html
- Airbnb JavaScript Style Guide -- https://github.com/airbnb/javascript
- Key conventions: prefer `unknown` over `any`; discriminated unions over enums;
  `readonly` / `as const` for immutable data; enable `strictNullChecks` (part of
  `strict`); use `===`; validate external data instead of casting; named exports.

## refactoring.guru mappings

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Stringly-typed status / primitive flags | Primitive Obsession (`/smells/primitive-obsession`) | Replace with discriminated union or a branded type; *not* a class hierarchy |
| Long function, high cognitive complexity | Long Method (`/smells/long-method`) | Extract Function (`/refactoring/techniques/composing-methods`) -- plain functions/closures, not Method Object |
| `switch` / `if-else` chains on a tag field | Switch Statements (`/smells/switch-statements`) | Keep an exhaustive `switch` over a discriminated union (with `never` default) -- this is idiomatic TS, *not* Replace Conditional with Polymorphism |
| Repeated bag of params passed together | Data Clumps (`/smells/data-clumps`) | Introduce an `interface`/`type` alias (Introduce Parameter Object); keep it a plain options object, not a class |
| Duplicated branch bodies (sonarjs) | Duplicate Code (`/smells/duplicate-code`) | Extract Function; consolidate duplicate conditional fragments |
| Unused exports / files (knip) | Dead Code (`/smells/dead-code`) | Delete the code |

Note: TS's structural typing + unions mean the OO catalog's polymorphism-heavy
fixes often over-engineer. Prefer a union + exhaustive `switch` (compiler-checked
via a `never` fallthrough) over subclasses.

## Pragmatism notes (for the adversarial pass)

- Not every `any` is wrong: genuinely dynamic boundaries (a generic event bus, a
  third-party lib with no types, `JSON.parse` *before* validation) may warrant a
  scoped `any` or `unknown`. Flag leakage into core logic, not isolated edges.
- A small, single-purpose barrel `index.ts` (a package's public surface) is fine;
  only flag barrels that create import cycles or pull in heavy unrelated code.
- Don't push classes where functions + closures are idiomatic -- TS is not Java.
  Module-level functions with a typed options object are usually the right call.
- A non-null `!` after an explicit guard (or in a test where the value is known)
  is acceptable; flag chains of `!` that paper over real nullability.
- `enum` is not always wrong -- a stable, exhaustively-handled numeric flag set
  can be a legitimate `enum`; the smell is leaking enum *values* across module
  boundaries or using it where a string-literal union reads better.
