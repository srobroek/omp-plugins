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

## Naming

OMP identifies each capability by its bare `name` field. It deduplicates names across every configured
source and keeps the first match. A name that two plugins share therefore resolves to one plugin and
hides the other, so prefix every name with the plugin that owns it.

## License

The Apache-2.0 license governs this repository. It appears in full in [LICENSE](LICENSE).
