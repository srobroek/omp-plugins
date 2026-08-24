# omp-plugins

An OMP marketplace catalog for the Oh My Pi coding agent.

| Field | Value |
| --- | --- |
| Status | Catalog not yet published |
| OMP catalog path | `.omp-plugin/marketplace.json` |
| Claude Code catalog path | `.claude-plugin/marketplace.json` |
| License | Apache-2.0 |

OMP reads the `.omp-plugin/` catalog and falls back to `.claude-plugin/`. A repository that ships both
therefore serves OMP and Claude Code from one source.

## Plugin layout

A plugin is a directory whose capabilities sit in fixed subdirectories. OMP locates each capability by
path, and a catalog entry cannot redirect that lookup.

| Path | Contributes |
| --- | --- |
| `skills/<name>/SKILL.md` | one skill, located without recursion |
| `agents/<name>.md` | one task agent |
| `commands/<name>.md` | one slash command |
| `rules/<name>.md` | one rule |
| `hooks/pre/`, `hooks/post/` | extension modules written in TypeScript or JavaScript |
| `tools/` | custom tools |
| `.mcp.json` | MCP server definitions |

`plugin.json` remaps two of these paths, `skills` and `commands`. The catalog keeps its `agents` and
`hooks` fields as inventory metadata, so moving either directory breaks discovery.

## Installing: link, do not install

Use `omp plugin link <dir>` for every plugin in this repository. A catalog install is not
equivalent, and the difference is silent rather than loud. Measured on a full 31-plugin estate:

| Carrier | Skills | Agents | Rules |
| --- | --- | --- | --- |
| `omp plugin install <name>@<marketplace>` | load | do not load | do not load |
| `omp plugin link <dir>`, no `omp` key in `package.json` | nothing loads: `omp plugin doctor` reports "not an omp plugin" | | |
| `omp plugin link <dir>`, with an `omp` key | load | load | load |

OMP walks the sibling `rules/` and `agents/` roots of an extension package it recognizes, and
nothing else. Recognition comes from a `package.json` carrying an `omp` key. The key may be empty
for a plugin that ships no extension modules: it is a marker, not a payload.
`scripts/sync-plugin-manifests.py` writes it for every plugin, so run that script after adding one.

Confirm with `omp plugin doctor` that every plugin appears as `✔`. A `⚠ … not an omp plugin` line
means that plugin's rules and agents are silently absent.

A rule is addressable only when it lands in a bucket. Read one back to prove it:

```
omp -p 'read rule://beads-core'
```

## Generated files

Three generators own the files below, so do not hand-edit them. CI fails when a committed copy drifts.

| File | Generator |
| --- | --- |
| `<plugin>/package.json`, `<plugin>/.omp-plugin/plugin.json` | `scripts/sync-plugin-manifests.py` |
| `.omp-plugin/marketplace.json`, `.claude-plugin/marketplace.json` | `scripts/build-catalog.py` |
| `release-please-config.json`, `.release-please-manifest.json` | `scripts/build-release-config.py` |

Each plugin owns its version in `<plugin>/.omp-plugin/plugin.json`. The release tool bumps only the
files its config names. OMP, meanwhile, compares `plugins[].version` in the single top-level
catalog, so a release assembles that catalog from the 31 manifests.

`scripts/check-contract.py` guards three failures that stay silent at runtime. A rule with no
`description` lands in no bucket. A frontmatter `name` that disagrees with its filename is not the
identity OMP uses. An agent re-using a bundled name shadows the bundled definition.

## Naming

OMP identifies each capability by its bare `name` field. It deduplicates names across every configured
source and keeps the first match. A name that two plugins share therefore resolves to one plugin and
hides the other, so prefix every name with the plugin that owns it.

## License

The Apache-2.0 license governs this repository. It appears in full in [LICENSE](LICENSE).
