# React (JSX/TSX components) -- Sniff Reference

One-line scope: React component code -- `.jsx`/`.tsx` files, hooks, JSX. Base
TS/JS language smells live in `./typescript.md`; this doc covers component- and
hook-level smells only. Reference, don't duplicate, typescript.md.

## Detect

How sniff knows React is present.
- Files/extensions: `.jsx`, `.tsx`; JSX in `.js`/`.ts`; `react` + `react-dom` in
  `package.json` dependencies.
- Config that governs it: ESLint config (`eslint.config.js` / `.eslintrc*`) with
  `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-jsx-a11y`;
  `tsconfig.json` (`"jsx": "react-jsx"`).

## Tools

Run ESLint with the React plugin stack first; it is the meta-linter and the only
tool that flags the highest-value hook smell (`exhaustive-deps`).

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| ESLint + `eslint-plugin-react` + `eslint-plugin-react-hooks` + `eslint-plugin-jsx-a11y` | **These are ESLint plugins, not separate binaries -- there is no per-plugin command.** **Run:** ensure all three are in the repo's eslint config, then the single `npx eslint --format json .` (file set = trailing `.`, walks the repo) executes every React/hooks/a11y rule in one pass. The key load-bearing rule is `react-hooks/exhaustive-deps`. **Config:** auto-uses the repo's eslint config -- no flag; if a plugin isn't configured its rules silently don't run (coverage gap -- note it). **Exit:** 0 = clean · **1 = lint errors → parse the JSON** · **2 = config/crash → INVALID.** **Gotcha:** needs `node_modules` present; a fresh worktree must `npm ci` first. | hook deps (`react-hooks/exhaustive-deps`), rules of hooks (`react-hooks/rules-of-hooks`), missing keys (`react/jsx-key`), unstable nested components, a11y | default-on (mandatory when React present) | `install-tools.sh --install js-ts` |
| typescript-eslint + `tsc` | **Run:** `npx tsc --noEmit -p <tsconfig>` (add `--strict` only if the repo's tsconfig doesn't already); parse the text diagnostics on stderr. 0 = clean · nonzero = type errors · tsconfig-not-found/bad-flag = INVALID. typescript-eslint rules ride the single eslint run above (same plugin model). Full recipe + the `npm ci` deps caveat live in `./typescript.md` -- don't duplicate. | prop/type smells, `any` leakage -- see `./typescript.md` | default-on | `install-tools.sh --install js-ts` |

Notes: ESLint is the React meta-linter -- do not stack point tools. The two
load-bearing rules are `react-hooks/exhaustive-deps` (missing/incorrect effect
deps) and `react-hooks/rules-of-hooks` (conditional hook calls). Base JS/TS
complexity, dup, and dead-code dimensions are owned by `./typescript.md`
(eslint-plugin-sonarjs, knip, type-coverage) -- run those once per repo, not
per-framework. `jsx-a11y` is the only a11y source here.

## Smell checklist

Component/hook smells beyond what tools flag. ESLint catches deps/keys/rules;
the rest below are design smells a reviewer must judge.

| Smell | What it looks like (React) | Idiomatic alternative |
|-------|----------------------------|-----------------------|
| Missing/incorrect effect deps | `useEffect(fn, [])` referencing props/state; deps lying to silence the linter | List every reactive value; or remove the effect entirely (see "effect for derived data") |
| Derived state in `useState` | `const [full, setFull] = useState()` then a `useEffect` keeping it synced to `first + last` | Compute during render: `const full = first + " " + last` |
| Effect for event-driven work | `useEffect` that POSTs/navigates in response to a user action | Do it in the event handler; effects are for synchronizing with external systems |
| Prop drilling (deep) | Same prop threaded through 3+ intermediate components that don't use it | Context, or component composition (pass JSX `children`) |
| Giant component | One component file doing fetch + form + list + modal, hundreds of lines | Extract child components; extract logic into custom hooks |
| Business logic in component | Data fetching / transforms / validation inline in the component body | Extract a custom hook (`useUserData`) or a plain module function |
| Inline function/object/array props | `<C style={{...}} onClick={() => ...} items={[...]} />` creating a new ref each render | Hoist stable values; `useCallback`/`useMemo` only where a memoized child or effect dep actually needs it |
| Missing list keys / index keys | `items.map(x => <Li/>)` with no `key`, or `key={index}` on a reorderable list | Stable unique `key` from data identity |
| Premature memoization | `useMemo`/`useCallback`/`memo` on cheap values everywhere "for performance" | Remove unless a profiled re-render or a referential-equality dep demands it |
| Context overuse | One context holding many unrelated values; every consumer re-renders on any change | Split contexts by update cadence, or pass state down via composition |

## Idioms & style authorities

- React docs -- "Thinking in React": https://react.dev/learn/thinking-in-react
- React docs -- "You Might Not Need an Effect": https://react.dev/learn/you-might-not-need-an-effect
- Rules of Hooks: https://react.dev/reference/rules/rules-of-hooks
- Key conventions:
  - Effects synchronize with *external* systems. Derived data is computed in
    render; event responses go in handlers -- not effects.
  - Custom hooks are the unit of logic reuse; composition (`children`) is
    preferred over inheritance and often over context.
  - Lift state only as high as the lowest common owner that needs it -- no higher.
  - Hooks run unconditionally at the top level, same order every render.

## refactoring.guru mappings

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| Giant component | Large Class (`/smells/large-class`) | Extract Component / Extract Custom Hook -- split UI into children, lift logic into a `use*` hook (not Extract Class) |
| Business logic in component | Large Class (`/smells/large-class`) | Extract Custom Hook for stateful logic; plain module function for pure logic |
| Duplicated logic across components | Duplicate Code (`/smells/duplicate-code`) | Extract a shared custom hook (the hook is the React Extract Method) |
| Over-long component body / JSX | Long Method (`/smells/long-method`) | Extract Component for JSX subtrees; Extract Method for handlers |
| Prop drilling / deep coupling | Message Chains (`/smells/message-chains`) | Context or composition rather than Hide Delegate |

The catalog's class/inheritance refactorings rarely apply -- React's unit of
extraction is the component and the hook, not the class.

## Pragmatism notes (for the adversarial pass)

- Not every component needs `memo`, and not every callback needs `useCallback`.
  Memoization is justified by a measured re-render cost or a real dependency
  identity requirement -- not by default.
- Prop drilling one or two levels is fine and clearer than a context. Reach for
  context at depth, or for genuinely global concerns (theme, auth, locale).
- Don't extract a custom hook used in exactly one place with no reuse intent --
  inlining is clearer. Hooks earn their keep through reuse or testability.
- Inline handlers/objects are fine for leaf elements (DOM nodes) -- the new
  reference only matters when it feeds a memoized child or an effect dep array.
- An `index` key is acceptable for static, never-reordered, never-filtered lists.
- A single large but cohesive component that isn't reused is not automatically a
  smell; split when responsibilities diverge, not by line count alone.
