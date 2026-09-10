# Layers

LOAD when selecting or inspecting a layer. Per-layer facts are authoritative in `templates/<layer>/layer.toml`; use the CLI instead of copying facts into this reference.

```sh
python3 skill://agentic-scaffold/scripts/scaffold.py layers list
python3 skill://agentic-scaffold/scripts/scaffold.py layers show lang/python
```

Every layer has `layer.toml` and a short `README.md`. The config declares ordering (`after`), required tools, whole-file ownership, managed block contributions, conflicts, variables, and project plugins. The renderer applies layers in profile order, then any `--layer` additions.

A profile is only a named ordered layer set plus variables and commands. Plugin sets belong to layers. `web-ui` is composable and contributes only its plugin set and an `AGENTS.md` block.

Layer ownership must be disjoint for a selected profile. A duplicate `owns` path or a declared `conflicts_with` pair makes `plan` exit 5 unless `--force-layer L` names the winner for that run.

The `workspace` layer is root-only. It derives member directories from the language family. Python and TypeScript use `packages/<name>`. Rust uses `crates/<name>`. Go uses `cmd/<name>` or `services/<name>`.

The optional `moon` layer requires `workspace`. The optional `worktrunk` layer works with any profile. Run `layers show workspace`, `layers show moon`, or `layers show worktrunk` for current fields.
