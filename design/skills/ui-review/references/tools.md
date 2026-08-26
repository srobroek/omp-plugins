# External commands

The canonical invocation for every external command this package names.
`rule://design-tool-ladder` answers WHICH tool for WHICH job; this file answers exactly HOW
to call it, and carries the caveats and side effects a bare command line does not show.

Any skill, formula, or agent that actually runs a command keeps that command inline, so its
workflow stays self-contained without following a link. The same text therefore appears in
more than one place. When two copies disagree, this file is the authority and the other copy
is the bug.

Commands only. The `accessibility-scanner`, `storybook`, `wire-dsl`, and `excalidraw` MCP
servers are routed by `rule://design-tool-ladder` and called as tools, not spawned as
processes, so they carry no invocation to record here.

## Never infer a package from a bin name

`npx` resolves its first non-flag argument as a package spec unless `--package` names one.
A bare name is safe only where the table below records that the package and the bin do
coincide, as `playwright` and `storybook` do. Never assume it from the bin alone: three
verified counter-cases are below. Two forms are always safe, and the difference between them
is the whole mechanism.

Form 1, name the PACKAGE as the spec. npx then runs that package's bin, whatever it is
called:

```
npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"
```

That is safe because the spec is the scoped package. It is NOT safe because the names match:
`@google/design.md` installs bins called `design.md` and `designmd`, so bin and package
differ here too.

Form 2, pass `--package` when the bin you need carries a different name and you cannot
express it as the spec:

```
npx --yes --package=@terrazzo/cli tz build
```

The failure case is only the third form, a BARE bin name as the spec. `npx --yes tz`
resolves whatever package happens to be published as `tz`. Measured: a bare `npx tz`
resolves a `tz` package that ships NO bin, a bare `npx dtokens` resolves an unrelated
`dtokens@0.1.3-beta`, and a bare `npx test-storybook` resolves an unrelated
`test-storybook@1.0.0` by a different author. That is a supply-chain hazard, not a typo.

Four tools below need `--package`: `test-storybook`, `axe`, `dtokens`, `tz`.

## Always `--yes`

A bare `npx` prompts for install consent and fails without a TTY, which is exactly the
unattended case this package runs in. Every row below carries `--yes`.

## Quote every substituted value

A URL carries `&` and `?`, and a path can carry a space. An argument written `<url>` or
`<repo>` is shell redirection the moment it is pasted literally. Every row below therefore
quotes its substitutions and writes them as `"<url>"`, `"<target>"`, so a line that reached
a shell unsubstituted fails on a literal path instead of acting on the wrong target.

Do NOT write these as `"$url"` or `"$target"`. Without `set -u` an unset variable expands to
nothing, so `"$repo/DESIGN.md"` becomes `/DESIGN.md` and `"$target"` becomes an empty
argument that a CLI may read as the working directory. Where a real shell variable is
wanted, derive it in the same line, as the `git rev-parse` form below does, or guard it with
`${target:?set target}`.

The DTCG glob is the exception: do NOT quote it. `dtokens` does not expand a glob itself, and
a quoted `'tokens/**/*.json'` reaches it literally and fails with
`Check failed: File not found: "tokens/**/*.json"`. Enumerate the token files with the
harness `glob` tool, then pass each path as its own quoted argument.

## Verification and measurement

| bin | npm package | invocation | what it is for | when to use it rather than the alternative |
|---|---|---|---|---|
| `impeccable` | `impeccable` 3.6.0 | `npx --yes impeccable detect "<target>" --json` | coarse rendered-UI defect scan over 59 detector rules | corroborating signal only; never instead of driving the surface, because findings carry `"line": 0` |
| `test-storybook` | `@storybook/test-runner` 0.24.4 | `npx --yes --package=@storybook/test-runner test-storybook --url http://localhost:6006 --json --outputFile sb.json --failOnConsole` | executes every story as a test against a running dev server | prefer `vitest` on Vite-powered frameworks, where the Vitest addon supersedes this runner |
| `axe` | `@axe-core/cli` 4.13.0 | `npx --yes --package=@axe-core/cli axe "<url>" --stdout --exit` | multi-URL accessibility gate that exits non-zero | only when a process exit is the requirement; the `accessibility-scanner` MCP is the primary route and puts no ChromeDriver in the path |
| `browser-driver-manager` | `browser-driver-manager` 2.0.1 | `npx --yes browser-driver-manager install chrome` | downloads a matched Chrome and ChromeDriver pair | it only downloads them. It puts neither on axe's path, so pass them yourself or the version skew it exists to prevent still happens. See the mapping below |
| `motionlint` | `motionlint` 0.2.1 | `npx --yes motionlint audit "<url>" --json audit.json --ci` | primary motion measurement: duration scoring and a reduced-motion sweep | leads over reading CSS by hand, because it measures what shipped |
| `playwright` | `playwright` 1.62.1 | `npx --yes playwright install chromium` | the one-time Chromium download MotionLint drives | first MotionLint run only |
| `lighthouse` | `lighthouse` 13.4.1 | `npx --yes lighthouse "<url>"` | its five categories: accessibility, best-practices, performance, seo, agentic-browsing | `lighthouse-mcp` is dropped as a duplicate of this CLI. There is no PWA category in 13.4.1 |

### Give axe a matched Chrome and ChromeDriver

`browser-driver-manager which` prints `KEY="value"` lines, so `eval` sets both paths in the
current shell. Take no positional argument: bare `which` reads the environment file the
install wrote, and both paths are absolute.

```bash
npx --yes browser-driver-manager install chrome
eval "$(npx --yes browser-driver-manager which)"
npx --yes --package=@axe-core/cli axe "<url>" --stdout --exit \
  --chrome-path "$CHROME_TEST_PATH" \
  --chromedriver-path "$CHROMEDRIVER_TEST_PATH"
```

Without those two flags the gate runs against whatever ChromeDriver it finds first, and a
version mismatch exits non-zero having tested nothing, which reads exactly like a real
accessibility failure.

## Token pipeline

| bin | npm package | invocation | what it is for | when to use it rather than the alternative |
|---|---|---|---|---|
| `design.md` | `@google/design.md` 0.4.0 | `npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"` | gates the authored artifact; exits 1 on errors | always derive the path: a bare `DESIGN.md` resolves against the session cwd and exits 2 with "not found" when the cwd is not the file's directory |
| `design.md` | same | `npx --yes @google/design.md diff "<before>" "<after>"` | review gate on a DESIGN.md edit; exits 1 when the after file carries more errors or warnings | use on every edit to an existing file, where `lint` alone cannot say whether the edit made it worse |
| `design.md` | same | `npx --yes @google/design.md export "$(git rev-parse --show-toplevel)/DESIGN.md" --format dtcg` | one-time bootstrap of DTCG tokens for a repo that has none | the FILE argument is positional and required: without it the command prints usage and emits nothing. Never the compiler input, because the export is lossy, so layered `tokens/**/*.json` stays canonical. Writes to stdout, so a file needs redirection |
| `dtokens` | `@design-token-kit/cli` 1.8.0 | `npx --yes --package=@design-token-kit/cli dtokens check --scope schema "<file>" ...` | independent DTCG schema gate; exits 2 on findings | runs BEFORE the build, because a build that succeeds on malformed source has only hidden the problem one layer down. It expands no glob, so enumerate the token files first and pass each as its own argument |
| `tz` | `@terrazzo/cli` 2.7.1 | `npx --yes --package=@terrazzo/cli tz build` | the single build authority: CSS custom properties, theme and density selectors, typed JS with a `.d.ts` | never alongside a second builder. Two engines means two artifact authorities |

## Storybook lifecycle

One package owns all four, so the package spec `storybook` and the bin `storybook` coincide
and no `--package` is needed.

| bin | npm package | invocation | what it is for | when to use it rather than the alternative |
|---|---|---|---|---|
| `storybook` | `storybook` 10.5.10 | `npx --yes storybook dev -p 6006 --ci --no-open --quiet --disable-telemetry` | the default route: serves `index.json`, `iframe.html`, and the manifests, and recompiles on change | keep it running rather than rebuilding. `--disable-telemetry` is not optional, because telemetry is on by default |
| `storybook` | same | `npx --yes storybook build -o "<dir>"` | static emit of the routes that framework serves, for a CI job or a one-shot read | only when no server should outlive the turn. Adding `--test` drops `manifests/docs.json` and the debugger page |
| `storybook` | same | `npx --yes storybook doctor` | configuration health report | before blaming a route for a config fault |
| `storybook` | same | `npx --yes storybook ai setup` | derives project-specific story instructions from the actual codebase | never unprompted, and never restated as static prose: the value is that it reads this repo |

## Prototype, artifact, and guidance

| bin | npm package | invocation | what it is for | when to use it rather than the alternative |
|---|---|---|---|---|
| `modern-web-guidance` | `modern-web-guidance` 0.0.185 | `npx --yes modern-web-guidance@latest search "<topic>"`, then `npx --yes modern-web-guidance@latest retrieve "<id,id>"` | current web-platform practice and baseline support, cited from the tool | prefer it over the `modern-web-guidance` plugin, because the CLI needs no install. `search` returns ids and `retrieve` takes them comma-separated; neither is a bare command. It needs network |
| none | `wireloom` 0.7.0 | `npm install wireloom` | installs the renderer, which exports `parse` and `render` | a project dependency rather than an `npx` run, because the package ships a library and NO bin. Installing renders nothing: a script must call `render` and write the SVG. See the render step below |
| `python3` | none | `python3 -m http.server "<port>" --bind 127.0.0.1` | serves a prototype so it can be driven rather than read | always for an interactive artifact. `--bind 127.0.0.1` keeps it off the network |
| `superdesign` | `@superdesign/cli` 0.13.0 | `npx --yes @superdesign/cli@latest create-project` | hosted concept exploration; the command prints the canvas URL | last resort, and only after the user confirms the account. With no subcommand it prints help and produces nothing. Run `login` first; `iterate-design-draft` continues an existing draft. Image and video generation consumes credits |

### Render a wireloom block to SVG

`render(id, source, options?)` returns `Promise<{ svg: string }>`, so the call is async and
nothing is written until a script writes it. `parse(source)` alone returns the AST and emits
no SVG.

```js
import { readFile, writeFile } from "node:fs/promises";
import { render } from "wireloom";

const source = await readFile("wireframe.wireloom", "utf8");
const { svg } = await render("wireframe", source);
await writeFile("wireframe.svg", svg);
```

An invalid source throws `WireloomError` carrying the line and column, so a thrown error is
a grammar fault rather than a missing dependency.

## Workspace

None of these is fetched. All are already installed where this package is used.

| bin | source | invocation | what it is for | when to use it rather than the alternative |
|---|---|---|---|---|
| `bd` | beads, installed | `bd mol pour "<tier>" --var surface="<route>" --var scope="<paths>"` | pours one of the three scoped tiers as a fresh molecule | a poured tier carries NO `mol-` prefix |
| `bd` | same | `bd mol bond "mol-<name>" "<target-id>" --var surface="<route>" --var node="<node-id>"` | bonds a sub-process molecule onto the step that found the work | `bd mol bond` resolves only prefixed stems, so the `mol-` prefix is load-bearing here |
| `omp` | OMP itself | `omp plugin marketplace add "<owner>/<repo>"` | registers a third-party catalog | `owner/repo` shorthand is a valid source; no clone path is needed |
| `omp` | same | `omp plugin install "<name>@srobroek-omp"` | installs one advertised catalog entry | an install applies from the NEXT session, because OMP discovers plugins at startup. Never install and retry inside one session |
| `curl` | preinstalled | `curl -sS -o /dev/null -w '%{http_code}' "<url>"` | proves a route serves: a story index, a manifest, a prototype URL | for reachability and status only. It returns transferred bytes, never a rendered surface, so a claim about what a page LOOKS like still needs `browser` |

## Never trust an exit code alone

Two gates above look like gates and are not. Read the JSON in both cases.

`motionlint audit --ci` does NOT gate on findings. Measured: it exited 0 while the same run
reported the accessibility warning `No prefers-reduced-motion path`. Read `audit.json` and
judge the findings.

The axe gate fails the other way. An environment fault also exits non-zero, so a non-zero
exit does not by itself mean a violation. Measured without a matched driver, it exits 2 on
`session not created: This version of ChromeDriver only supports Chrome version 152. Current
browser version is 151.0.7922.174`, having tested nothing at all. That reads exactly like a
failing audit. Read the JSON on `--stdout` and judge the findings.

## Two side effects a caller cannot guess

`motionlint audit` writes `.motionlint/audit/index.html` into the CALLER's working directory
rather than a temp dir, and nothing gitignores it. Run it with `cwd` set to a scratch
directory, or add `.motionlint/` to `.gitignore` first, or the pass leaves a report to be
committed by accident. The HTML is the human view of findings the JSON already carries, so
discarding it loses nothing.

`storybook` writes a `*.log` into the caller's cwd on a crash or a debug run. Same
treatment: a scratch cwd, or expect an untracked log beside the source.

## Three upstream script paths that are not commands yet

These three are documented by their upstreams as if they were runnable. Each carries a
placeholder that never expands on its own, so each reaches the shell unexpanded and the
lookup fails. Resolve the real installed directory FIRST, then substitute it.

```
${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py
<installed-ss-tokens>/scripts/generate-palette.mjs
<installed-ss-score>/scripts/styleseed-check.mjs
```

`${CLAUDE_PLUGIN_ROOT}` is substituted only into MCP `command`, `cwd`, `args`, and `env`,
never into skill body text and never into the shell. The two StyleSeed forms are literal
prose placeholders and were never variables at all.

`search.py` also needs a POSITIONAL query, so the working form is a query string plus the
flag:

```
python3 "<installed>/scripts/search.py" "<query>" --design-system
```

`--design-system` alone exits with `the following arguments are required: query`, which is a
tool error and not an empty result. Never report it as "no findings".
