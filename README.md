# omp-plugins

An OMP marketplace catalog for the Oh My Pi coding agent.

| Field | Value |
| --- | --- |
| Status | Published: `omp plugin marketplace add srobroek/omp-plugins` |
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

## Installing

Either carrier works for every plugin in this repository. Measured on a 27-plugin estate:

| Carrier | Skills | Agents | Rules |
| --- | --- | --- | --- |
| `omp plugin install <name>@<marketplace>` | load | load | load |
| `omp plugin link <dir>` | load | load | load |
| either carrier, with no `omp` key in `package.json` | nothing loads: `omp plugin doctor` reports "not an omp plugin" | | |

OMP walks the sibling `rules/` and `agents/` roots of an extension package it recognizes, and
nothing else. Recognition comes from a `package.json` carrying an `omp` key. The key may be empty
for a plugin that ships no extension modules: it is a marker, not a payload.
`scripts/sync-plugin-manifests.py` writes it for every plugin, so run that script after adding one.

A marketplace install copies the whole plugin directory, `package.json` included, which is why the
recognition condition decides both carriers rather than the carrier deciding it.

`omp plugin list` shows every plugin under either carrier. `omp plugin doctor` adds a
`✔ plugin:<package>` line for a linked directory only, so use it while developing here: a
`⚠ … not an omp plugin` line means that directory's rules and agents are silently absent.

A rule is addressable only when it lands in a bucket. Read one back to prove it, naming a rule
from a plugin you installed:

```
omp -p 'read rule://beads-core'
```

A rule from an uninstalled plugin answers `No such rule` and lists the rules that did load,
which is the same evidence in the negative.

## Generated files

Three generators own the files below, so do not hand-edit them. CI fails when a committed copy drifts.

| File | Generator |
| --- | --- |
| `<plugin>/package.json`, `<plugin>/.omp-plugin/plugin.json` | `scripts/sync-plugin-manifests.py` |
| `.omp-plugin/marketplace.json`, `.claude-plugin/marketplace.json` | `scripts/build-catalog.py` |
| `release-please-config.json`, `.release-please-manifest.json` | `scripts/build-release-config.py` |

Each plugin owns its version in `<plugin>/.omp-plugin/plugin.json`. The release tool bumps only the
files its config names. OMP, meanwhile, compares `plugins[].version` in the single top-level
catalog, so a release assembles that catalog from the 27 manifests.

The catalog carries 38 entries: the 27 plugins here, plus 11 third-party plugins it advertises from
`scripts/third-party-plugins.json`. An advertised entry is a pointer, not a dependency: installing a
plugin from this catalog pulls in none of the others. `scripts/check-catalog-validation.py` rejects a
malformed third-party file rather than publishing the catalog without those entries.

`scripts/check-contract.py` guards three failures that stay silent at runtime. A rule with no
`description` lands in no bucket. A frontmatter `name` that disagrees with its filename is not the
identity OMP uses. An agent re-using a bundled name shadows the bundled definition.

## Naming

OMP identifies each capability by its bare `name` field. It deduplicates names across every configured
source and keeps the first match. A name that two plugins share therefore resolves to one plugin and
hides the other, so prefix every name with the plugin that owns it.

## License

The Apache-2.0 license governs this repository. It appears in full in [LICENSE](LICENSE).
