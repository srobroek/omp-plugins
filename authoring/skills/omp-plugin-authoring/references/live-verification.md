# Isolated live verification

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
