# Approved sources

Search in tier order and stop at the first tier that covers a capability.

## Tier 1: this repository

| Marketplace | Repo | Covers |
|---|---|---|
| `srobroek-omp` | `srobroek/omp-plugins` | language rules, delivery, beads, design, quality, safety, toolchain, and the other packages `omp plugin discover srobroek-omp` lists |

`srobroek-omp` also carries `ui-skills` and `platform-design-skills`. Neither upstream ships a
marketplace, so this catalog is how they install.

## Tier 2: approved third-party marketplaces

Register one with `omp plugin marketplace add REPO`. The name is the marketplace's own, from
its `marketplace.json`, and `omp plugin install` needs that name.

| Marketplace name | Repo | Covers |
|---|---|---|
| `slopvac` | `srobroek/slopvac` | prose quality gate |
| `sniff` | `srobroek/sniff` | code-smell analysis |
| `sabot` | `srobroek/sabot` | hardening and fuzzing |
| `project-scaffold` | `srobroek/agentic-scaffold` | project scaffolding |
| `mattpocock` | `mattpocock/skills` | engineering-practice skills |
| `obsidian-skills` | `kepano/obsidian-skills` | Obsidian notes, bases, canvas |
| `impeccable` | `pbakaus/impeccable` | design workflow and anti-slop |
| `styleseed` | `bitjaru/styleseed` | design-system tokens, lint, review |
| `addy-web-quality-skills` | `addyosmani/web-quality-skills` | web accessibility, performance, SEO |
| `effective-html` | `plannotator/effective-html` | HTML wireframes and prototypes |
| `googlechrome` | `GoogleChrome/modern-web-guidance` | current web platform practice |
| `frontend-slides` | `zarazhangrui/frontend-slides` | 16:9 decks |
| `web-asset-generator-marketplace` | `alonw0/web-asset-generator` | favicons, app icons, social images |
| `interface-design` | `Dammyjay93/interface-design` | product-UI craft for dashboards, admin panels, and SaaS tools; not marketing pages |

The design rows other than `interface-design` are also installed on demand by
`rule://design-upstream-preflight`. `interface-design` is optional: no design skill routes to
it, and it overlaps `impeccable`. Vetted 2026-09-28: MIT, last push 2026-06-20, not archived.
A project-scope install loads its one skill, `interface-design`, from the manifest's
`./.claude/skills` path.

## Tier 3: open search, after the ASK gate

| Surface | Command | Finds | Vetted |
|---|---|---|---|
| `find_tools_scan` | the tool, with the capability query | MCP Registry, npm, GitHub marketplace files, Smithery when `SMITHERY_API_KEY` is set | read-only, no approval needed |
| skills CLI | `npx --yes skills@1.7.0 find QUERY` | skills indexed at skills.sh | `vercel-labs/skills`, MIT, about 9.8M downloads a week (2026-09) |
| Smithery skills | `npx --yes smithery@1.2.0 skill search QUERY --json` | Smithery's skill index | `smithery-ai/cli`, AGPL-3.0 (2026-09) |
| Smithery MCP | `npx --yes smithery@1.2.0 mcp search QUERY` | Smithery's MCP registry | same package |

Both CLIs are pinned to the versions vetted above. Re-vet before changing a pin: registry
page, maintainer, license, downloads, last release.

A tier 3 hit is a candidate, never an approval. Record its source URL, license, and last
activity, then judge it with `skill://find-tools/references/adoption-policy.md`.
