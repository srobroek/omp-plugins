# Upstream routes for design-md

| Upstream skill | Repo | Install |
|---|---|---|
| `create-design-md` | `ibelick/ui-skills` | `omp plugin install ui-skills@srobroek-omp` |

MIT with a LICENSE file (Copyright 2026 Julien Thibeaut). Skill granularity is the whole
plugin, so the entry also installs `baseline-ui`, `fixing-accessibility`,
`fixing-metadata`, `fixing-motion-performance`, `improve-ui`, and `ui-skills-root`. None
of those is routed to here: `fixing-accessibility` is displaced by
`skill://accessibility-audit`, `fixing-motion-performance` by `skill://motion-design`,
and `baseline-ui` and `improve-ui` by `impeccable`.

`fixing-metadata` is the closest call. It covers Open Graph, favicons, canonical URLs,
robots, Twitter cards, manifests, theme colour, and JSON-LD, which nothing else here
audits. It is not routed to because it is a prose checklist that emits no located
finding, and `web-asset-generator` covers the production half of the same ground by
generating and validating the assets.

## The CLI needs no install

`npx` fetches it per run. `@google/design.md` is 0.4.0, Apache-2.0, and installs two bins,
`design.md` and `designmd`. Its npm metadata declares no `license` field; the licence comes
from the LICENSE file at `google-labs-code/design.md`.

```
npx @google/design.md lint DESIGN.md
npx @google/design.md diff before after
```

It has exactly four subcommands: `lint`, `diff`, `export`, `spec`. `export` writes to
stdout, so a file comes from redirection, and its formats are `json-tailwind`,
`css-tailwind`, `tailwind`, `dtcg`, and `css-vars`. The last is present in the source and
absent from the README.

`diff before after` exits 1 when the after file carries more errors or warnings than the
before file, which is what makes it a review gate rather than a report.

## The eleven lint rules, and two limits

Error: `broken-ref`. Warnings: `missing-primary`, `contrast-ratio`, `orphaned-tokens`,
`missing-typography`, `section-order`, `unknown-key`, `token-like-ignored`. Info:
`token-summary`, `missing-sections`, `omitted-rules`.

Two limits invite false confidence and are called out in the skill body. `contrast-ratio`
warns only below 4.5:1 and only on component `backgroundColor` and `textColor` pairs, so
it is not a 3:1 UI-boundary gate and not a theme matrix. And the dimension pattern is
`^(-?\d*\.?\d+)([a-zA-Z%]+)$`, capped at 64 characters, so `clamp(2.5rem, 7vw, 4.5rem)`
is not a dimension to the linter at all.

## Exemplars

`https://github.com/VoltAgent/awesome-design-md` is MIT and is a corpus of DESIGN.md
files rather than a plugin, so it is a reading reference and not an install.
