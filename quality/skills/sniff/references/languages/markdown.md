# Markdown / MDX -- Sniff Reference

One-line scope: Markdown documentation -- `.md`, `.markdown`, `.mdx` files and the
links between them.

## Detect

How sniff knows Markdown is present: file extensions and lint config.
- Files/extensions: `*.md`, `*.markdown`, `*.mdx`
- Config that governs it: `.markdownlint.jsonc` / `.markdownlint.yaml` /
  `.markdownlint-cli2.{jsonc,yaml,cjs}`, `lychee.toml`, `.lycheeignore`

## Tools

The analyzers to run, primary first. Exact invocation + machine-readable flag.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| markdownlint-cli2 | **Run recipe.** `markdownlint-cli2 "**/*.md"` from repo root (quote the glob so the shell does not expand it; markdownlint-cli2 globs internally). Auto-reads `.markdownlint*` / `.markdownlint-cli2.*` config from the repo and honors disabled rules (e.g. a relaxed `MD013`). **Exit:** 0 = clean · 1 = findings → parse the per-file `file:line rule description` lines on stdout · any other code = INVALID. **Gotcha:** with NO project config, `MD013` (line-length, 80 cols) fires by default and floods prose docs with noise -- do NOT report those as real findings. When the repo has no markdownlint config, pass one that disables it: `markdownlint-cli2 --config <tmp.jsonc with {"MD013": false}> "**/*.md"`. | heading levels, list markers, fence language hints, trailing whitespace, hard tabs, line length, bare URLs, duplicate headings, missing alt text | default-on | `install-tools.sh --install docs` |
| lychee | **Run recipe (opt-in, network).** `lychee --format json --cache <paths>` from repo root -- pass explicit doc paths/globs; `--cache` reuses prior results to avoid re-hitting every URL. Reads `lychee.toml` + `.lycheeignore` from the repo if present. **Exit:** 0 = all links live · non-zero = dead links found → parse the JSON (`fail_map` lists failures per file) · distinguish a real link failure from a tool/network error (proxy down, rate-limit) which is INVALID, not "broken links". Requires network; run only when CI/network access is available. | dead/broken links, dead anchors, hardcoded/absolute link targets | opt-in (network access; CI) | `install-tools.sh --install docs` |
| cspell | **Run recipe (opt-in).** `cspell --no-progress <paths>` from repo root -- pass explicit doc paths/globs; `--no-progress` keeps output parseable (one `file:line:col - Unknown word (foo)` per finding). Auto-reads `cspell.json`/`.cspell.json`/`cspell.config.*` for the project dictionary + ignore words; with no config it uses bundled dictionaries (expect more unknown-word noise -- treat as advisory). **Exit:** 0 = no unknown words · 1 = unknown words found → parse stdout · 2 = config/usage error = INVALID. Offline; spelling is advisory, not a structural finding. | offline spell-check with bundled dictionaries | opt-in (run on demand) | `install-tools.sh --install docs` |

Notes: markdownlint-cli2 is the meta-linter for structural/style smells -- it
respects `.markdownlint*` config so honor project rule customizations (e.g. a
relaxed `MD013` line-length). lychee owns link liveness (network + intra-repo
anchors); markdownlint does not verify link targets. cspell is offline
spell-checking against bundled dictionaries -- opt-in, not a structural finding.
**vale (prose linting) is intentionally EXCLUDED** from sniff -- it audits
grammar/word-choice/register, which is prose style / linguistics, not code smell,
and is out of scope. Prose register lives in the `write-docs` package, which runs
Vale against its own house style; that split is deliberate, not an oversight.

## Smell checklist

The smells to look for, beyond what tools flag. Each: what it looks like + the
idiomatic alternative. Markdown-specific, not generic OO.

| Smell | What it looks like (Markdown) | Idiomatic alternative |
|-------|-------------------------------|-----------------------|
| Skipped heading levels | `#` jumps straight to `###`; non-monotonic nesting | Increment one level at a time (`MD001`); restructure outline |
| Dead / broken links | 404 targets, moved pages, dead `#anchor` refs | Fix or remove; let lychee verify each target |
| Bare URLs | `See https://example.com` pasted inline | `[descriptive text](https://example.com)` (`MD034`) |
| Inconsistent list markers | Mixing `-`, `*`, `+` or `1.`/`1)` in one list | Pick one marker style repo-wide (`MD004`/`MD029`) |
| Missing code-fence language | ```` ``` ```` with no language hint | ```` ```bash ```` / ```` ```json ```` for highlighting (`MD040`) |
| Hardcoded absolute repo paths | `[x](/Users/me/repo/docs/x.md)` or full `https://github.com/...blob/...` to own files | Repo-relative link `[x](../x.md)` so it survives moves/forks |
| Duplicate headings | Two `## Setup` collide, breaking generated anchors | Make headings unique or scope them (`MD024`) |
| Trailing whitespace / hard tabs | Stray spaces at EOL; literal tabs for indent | Strip trailing space (`MD009`); use spaces (`MD010`) |
| Over-long lines | Lines past a project-enforced limit | Wrap to the configured `MD013` width (only if enforced) |
| Missing image alt text | `![](diagram.png)` with empty alt | `![Sequence of the auth flow](diagram.png)` (`MD045`, a11y) |
| Gratuitous HTML-in-markdown | `<b>`, `<ul><li>` where markdown syntax suffices | Use native `**bold**`, `-` lists (`MD033`); reserve HTML for tables/`<details>` |
| Stale TOC | Hand-written table of contents out of sync with headings | Regenerate from headings, or drop the manual TOC |

## Idioms & style authorities

The leading specs/guides for Markdown, with URLs.

- CommonMark spec -- https://commonmark.org/
- markdownlint rules reference -- https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md
- Google documentation style guide -- https://google.github.io/styleguide/docguide/style.html
- Key conventions: one consistent heading hierarchy (no skipped levels);
  repo-relative links over absolute; fenced code blocks with a language hint;
  alt text on every image; one list-marker style throughout.

## refactoring.guru mappings

The refactoring.guru catalog is an **object-oriented** catalog and maps **weakly**
to prose documentation -- most smells (Long Method, Feature Envy, Switch
Statements) have no honest analog in Markdown. Cite sparingly and only where the
mapping is real.

| Markdown smell | refactoring.guru smell | Idiomatic refactoring |
|----------------|------------------------|-----------------------|
| Copy-pasted boilerplate across docs | Duplicate Code (`/smells/duplicate-code`) | Extract into a shared include/snippet **only** where the toolchain supports transclusion (MDX imports, Hugo/Jekyll/Docusaurus includes); plain CommonMark has none -- leave duplication be |

Note: the **Comments** smell (`/smells/comments`) is **inverted** here -- in code,
explanatory comments often compensate for unclear code; in docs the prose **is**
the artifact, so "too much comment" is not a smell. Do not flag documentation for
explaining things.

## Pragmatism notes (for the adversarial pass)

Where "fixes" over-reach in Markdown -- false positives the `refactor-challenger`
should protect.

- Line-length limits are **project-dependent**. Do not flag long lines unless the
  project actually enforces `MD013` (a configured width); prose is often
  intentionally unwrapped one-sentence-per-line.
- Some HTML-in-markdown is **necessary**: tables with complex cells, `<details>`
  collapsibles, `<sub>`/`<kbd>`, anchor targets. Flag only HTML that duplicates
  plain-markdown syntax.
- Not every doc needs a **table of contents** -- short docs and READMEs often
  read fine without one. Only flag a TOC that is stale, never its absence.
- Prose **quality, grammar, tone, and word choice are not sniff concerns** -- that
  is vale's territory and out of scope. Sniff audits structure and links, not
  writing.
- A bare URL inside a fenced code block (an example, not a link) is intentional --
  do not "fix" it into a markdown link.
