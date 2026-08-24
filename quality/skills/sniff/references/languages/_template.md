# <Language / Format> -- Sniff Reference

> Authoring template for a sniff language doc. Copy this, fill every section,
> keep it self-contained (a `bloodhound` agent reads ONLY this doc for the
> language). Aim for tight, concrete content -- checklists over prose. Delete
> this blockquote in real docs.

One-line scope: what this doc covers (e.g. "Go source: `.go` files, `go.mod`").

## Detect

How sniff knows this language/format is present: key files, extensions, config.
- Files/extensions: `...`
- Config that governs it: `...`

## Tools

The analyzers to run, primary first. This table is the **authoritative** tool
list for this target. Each row needs all five columns; the universal run-rules
(cwd=repo root, project-config-wins, exit-codes, absolutize shipped assets) live
in `../tooling.md` -- don't restate them, add only tool-specific detail.

| Tool | Run recipe | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| <primary> | **exact command** + machine-readable flag + how the file set is passed; **config:** auto-uses project config / needs `--config` / no-config fallback; **exit:** 0 clean · N findings (parse) · usage/crash = INVALID (fix+re-run, never "clean"); any gotcha | <dimensions> | default-on | `install-tools.sh --install <bundle>` |
| <secondary> | … | <dimensions> | opt-in (reason) | … |

- **Tier** is `default-on` (pre-selected in the Step-2 proposal) or `opt-in`
  (shown off, with the reason: nightly / redundant-with-X / heavy / security-only
  / needs-baseline). Default-on = run it for a thorough audit unless redundant.
- **Run recipe** must be complete enough to run without guessing -- a terse
  invocation is what causes bad-flag / wrong-cwd / unhandled-crash bugs.

Notes: which tool is the meta-linter, what overlaps, what to skip if another is
present. Note when the standard toolchain already covers a dimension.

## Smell checklist

The smells to look for, beyond what tools flag. Each: what it looks like + the
idiomatic alternative. Group by category. Be language-specific -- not generic OO.

| Smell | What it looks like (this language) | Idiomatic alternative |
|-------|-----------------------------------|-----------------------|
| ... | ... | ... |

## Idioms & style authorities

The leading style guide(s)/handbook(s) for this language, with URLs. State the
few conventions most worth enforcing.

- <Guide name> -- <URL>
- Key conventions: ...

## refactoring.guru mappings

The smells common in this language → the catalog entry to cite (see
`../refactoring-catalog.md`). Note where the language-idiomatic fix differs from
the generic catalog.

| This-language smell | refactoring.guru smell | Idiomatic refactoring |
|---------------------|------------------------|-----------------------|
| ... | ... | ... |

## Pragmatism notes (for the adversarial pass)

Where "fixes" commonly over-reach in this language -- the false positives and
non-idiomatic-but-fine patterns the `refactor-challenger` should protect.

- ...
