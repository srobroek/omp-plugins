# Interview

LOAD when `inspect` is complete or a greenfield run needs answers. Answers are committed in `.omp/scaffold-answers.toml` by `answers write`; do not hand-edit generated files.

## Greenfield fixed set

Ask in order, skipping anything derivable from the preceding answer:

1. **Name and one-line purpose.** Default name is the destination basename; purpose defaults to the profile summary.
2. **Kind:** `lib | app | service | cli`. Default `app`; `cli` derives `app`.
3. **Language:** `python | ts | rust | go | terraform | none`. Default `none`.
4. **License.** Default `apache-2.0`; when unsure, load `skill://license-picker`.
5. **Create remote now?** Default `no`; if yes, visibility defaults `private`.
6. **Beads?** Default `yes` when `bd` is on PATH, otherwise `no`.
7. **Web UI?** Default `no`; yes appends the `web-ui` layer.
8. **SpecKit?** Default `no`; yes adds the `speckit` project plugin.

Derivations: `kind` selects the profile suffix (`-lib`/`-app`); language selects the profile; `cli` selects `app`; web UI appends `web-ui`; Speckit is a variable. Ask no framework, provider, or tooling questions already fixed by a layer.

## Brownfield fixed set

1. Confirm the profile suggested by `inspect`.
2. Choose optional layers to adopt. Default is `agentic + hooks + tooling` only.
3. Resolve each human finding: foreign hook manager, unowned `.omp/*` files, and ambiguous `AGENTS.md` markers.

Hook-manager choices are `hooks install --force` (repository hooks), moving `core.hooksPath` to repository scope, or skipping hooks; a refusal records all options and doctor reports drift. Unowned files require explicit `--adopt`; never auto-adopt. A foreign `AGENTS.md` block is preserved and gets `update-block`; only damaged/duplicated agentic markers or symlinks conflict.

## Command

```sh
python3 skill://agentic-scaffold/scripts/scaffold.py answers write --root R --profile P --set name=NAME --set language=python
```

Precedence is CLI `--var`/`--set` > profile `[vars]` > layer `[vars]`. `--layer` appends for the run and is stored in the answers file.

## Workspace questions

Ask `layout: single | monorepo` after kind and language. Default is `single`.

For `monorepo`, ask a bounded repeated set for each member: name, language, and kind. Use `member add --name N --layer lang/X --kind K`. Stop when the user says done. Store members as `[[members]]` in the answers file.

For brownfield work, detect a workspace manifest during `inspect`. Offer `member import --dir packages/name --layer lang/X`. Import records the member and preserves existing member files.
