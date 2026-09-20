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

## Precedence

When guidance conflicts, layers apply in this order:

| Order | Layer |
| --- | --- |
| 1 | Global `~/.omp/agent/AGENTS.md` |
| 2 | Repository `AGENTS.md` |
| 3 | TTSR rules |
| 4 | Plugin rules |
| 5 | Skills |
| 6 | Agent prompts |

Lower layers add; they never override a higher layer.


## Plugin layout

OMP locates each capability by path; catalog entries cannot redirect that lookup.


- `skills/<name>/SKILL.md`: one skill, located without recursion.
- `agents/<name>.md`: one task agent.
- `commands/<name>.md`: one slash command.
- `rules/<name>.md`: one rule.
- `hooks/pre/` and `hooks/post/`: TypeScript or JavaScript extension modules.
- `tools/`: custom tools.
- `.mcp.json`: MCP server definitions.
`plugin.json` remaps two of these paths, `skills` and `commands`. The catalog keeps its `agents` and
`hooks` fields as inventory metadata, so moving either directory breaks discovery.

## Installing

Either carrier works for every plugin in this repository. Measured on a 27-plugin estate:

| Carrier | Skills | Agents | Rules |
| --- | --- | --- | --- |
| `omp plugin install <name>@<marketplace>` | load | load | load |
| `omp plugin link <dir>` | load | load | load |
| either carrier, with no `omp` key in `package.json` | nothing loads: `omp plugin doctor` reports "not an omp plugin" | | |

OMP recognizes an extension package when its `package.json` carries an `omp` key.

The key may be empty for a plugin that ships no extension modules. It marks the package.

- OMP walks the package's sibling `rules/` and `agents/` roots, and nothing else.

- `scripts/sync-plugin-manifests.py` writes the key for every plugin. Run it after adding one.

- Marketplace installs copy the whole plugin directory, including `package.json`.
  Both carriers use the same recognition rule.

`omp plugin list` shows every plugin under either carrier. `omp plugin doctor` adds a
`✔ plugin:<package>` line for a linked directory only, so use it while developing here: a
`⚠ … not an omp plugin` line means that directory's rules and agents are silently absent.

For JSON inventory, `omp plugin list --json` separates two registry views:

- `npm` entries are runtime package registrations. They may be enabled or disabled; `enabled: true` indicates the configured runtime selection.
- `marketplace` entries are user/project installed-plugin registry records. Each `installPath` points to a cached copy; this list does not scan arbitrary cache directories.

Historical marketplace versions can coexist. A cached `installPath` proves that a marketplace record exists, not that the record is the configured runtime or that an already-running session loaded it. `omp plugin doctor` checks installed runtime package health, not arbitrary cache records.
In the observed inventory, `@srobroek/delivery` v0.10.4 is enabled at `node_modules`. Marketplace user records retain v0.10.6 and v0.10.8 cache paths. Doctor checks v0.10.4 and reports 4 OK, 0 warnings, and 0 errors.

A rule is addressable only when it lands in a bucket. Read one back to prove it, naming a rule
from a plugin you installed:

```
omp -p 'read rule://beads-core'
```

A rule from an uninstalled plugin answers `No such rule` and lists the rules that did load,
which is the same evidence in the negative.

## Developer tools

Run `mise install` after cloning or creating a worktree. Mise installs the pinned `slopvac` and `biome` tools used by local checks.

## Developer hook setup

After cloning or creating a worktree, run:

```sh
./scripts/install-agnix-hooks.py
```

The installer preserves the previous hooks path and all existing hooks. The tracked `pre-commit` wrapper runs agnix against the staged index before each commit. Git does not install tracked hooks automatically when you clone.

## Generated files

Three generators own the files below, so do not hand-edit them. CI fails when a committed copy drifts.

| File | Generator |
| --- | --- |
| `<plugin>/package.json`, `<plugin>/.omp-plugin/plugin.json` | `scripts/sync-plugin-manifests.py` |
| `.omp-plugin/marketplace.json`, `.claude-plugin/marketplace.json` | `scripts/build-catalog.py` |
| `release-please-config.json`, `.release-please-manifest.json` | `scripts/build-release-config.py` |

Each plugin owns its version in `<plugin>/.omp-plugin/plugin.json`. The release tool bumps only the
files its config names. OMP, meanwhile, compares `plugins[].version` in the single top-level
catalog, so a release assembles that catalog from the 26 manifests.

The catalog carries 37 entries: the 26 plugins here, plus 11 third-party plugins from
`scripts/third-party-plugins.json`. Install resolution is package-local.
`scripts/check-catalog-validation.py` rejects malformed third-party input instead of publishing
an incomplete catalog.

`scripts/check-contract.py` guards three failures that stay silent at runtime. A rule with no
`description` lands in no bucket. A frontmatter `name` that disagrees with its filename is not the
identity OMP uses. An agent re-using a bundled name shadows the bundled definition.

## Naming

OMP identifies each capability by its bare `name` field. It deduplicates names across every configured
source and keeps the first match. A name that two plugins share therefore resolves to one plugin and
hides the other, so prefix every name with the plugin that owns it.

## License

The Apache-2.0 license governs this repository. It appears in full in [LICENSE](LICENSE).
