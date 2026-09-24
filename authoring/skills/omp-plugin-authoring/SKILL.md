---
name: omp-plugin-authoring
description: Use when creating, packaging, installing, or debugging an OMP plugin (skills, rules, agents, extensions) or a marketplace.
---

# OMP Plugin Authoring

TRIGGER
+ creating or packaging an OMP plugin / marketplace
+ install loaded no surface, or `omp plugin doctor` says "not an omp plugin"
+ `omp plugin doctor` / `rule://` / upgrade-all looks wrong
- writing a TTSR vs tool vs skill decision → `skill://omp-surface-choice`
- writing a tool_call/extension module → `skill://omp-extension-safety`

## Install carrier

Use the repository's manifest and marketplace documentation as the source of truth for install and discovery behavior. Keep package metadata and tree layout consistent with the plugin contract; verify the result with the repository's loader checks.


## Verify

1. Run the repository's plugin doctor or loader smoke check and resolve every reported failure.
2. Prove a rule is addressable: `omp -p 'read rule://<name>'`.
3. Ensure every rule has the metadata required by the repository's validator.

## Isolated live verification

An isolated run MUST pass an explicit `modelRoles` overlay and a minimal models configuration. An empty `modelRoles` lets root and subagent sessions fall through to automatic model selection.

Set `MODEL_ROLES` to the reviewed overlay and `MODELS` to its matching minimal model definitions. Load every extension declared by the plugin manifest; `--plugin-dir` alone does not load extension tools.

```sh
PLUGIN_DIR=/path/to/plugin
MODEL_ROLES=/path/to/model-roles.yml
MODELS=/path/to/models.yml
EXTENSION_ARGS=()
while IFS= read -r extension; do
  EXTENSION_ARGS+=( -e "$PLUGIN_DIR/${extension#./}" )
done < <(jq -r '.omp.extensions[]?' "$PLUGIN_DIR/package.json")
omp -p --plugin-dir "$PLUGIN_DIR" --config "$MODEL_ROLES" --config "$MODELS" "${EXTENSION_ARGS[@]}"
```

After the run, perform a model census across every session record. Confirm that the root and every subagent resolved to the selectors named by `MODEL_ROLES`; reject any automatic or unexpected model. Probe at least one extension tool from the plugin and treat `Unknown tool` or `No such tool` as a loader failure until each declared extension was passed with `-e`.

## Rule identity

MUST Filename stem is the identity for `native` / `omp-plugins` providers.
MUST Frontmatter `name` equals that stem.
MUST Capability dedup is **bare-name first-wins** across every source.
MUST Prefix plugin rule filenames (`authoring-foo`, not `foo`).
NOT Re-ship a bundled agent name: `scout`, `librarian`, `reviewer`, `security-reviewer`, `designer`, `task`, `sonic`.

## Frontmatter and indexes

MUST Arrays are single-line flow YAML (`globs: ["**/*.ts"]`). Fallback parser cannot rebuild multiline arrays (`omp://rulebook-matching-pipeline.md` §3).
NOT Ship an always-apply index listing the plugin's rules. OMP already renders every rulebook rule as `- name (globs): description` in `<domain-rules>`. An index doubles it.

## Skills layout

MUST Discover only `<root>/<name>/SKILL.md`. No deeper nesting.
DEFAULT `plugin.json` `skills` arrays remap when the default tree is wrong.
MUST Bodies cite assets as `skill://<name>/<path>`. Never absolute paths.
NOT Bodies that bake host paths; they die on any other machine.

## Catalog and release

DEFAULT Catalog at `.omp-plugin/marketplace.json`; `.claude-plugin/` is the Claude fallback (`omp://marketplace.md`).
MUST Every catalog entry that should upgrade declares `version`. No `version` → invisible to upgrade-all.
MUST Publish the catalog from a supported source: a local path, a GitHub shorthand, a git URL, or a direct catalog URL. `marketplace.autoUpdate` (`off` / `notify` / `auto`) and upgrade-all resolve it from there, never from npm. OMP has no subscription mechanism, so an npm registry publication reaches no install path.
MUST release-please `extra-files` paths are **package-relative**. A repo-root path silently doubles the prefix.
