# Layout API for CAD commands

`scripts/layout.py` is the one reader of `layout.json`. [layout.md](layout.md) is the path table it
serves. The module uses the standard library only.

Load it by path under the name `cad_record_layout`. `validate.py` uses the same name, so a process
shares one module and one `LayoutError` class:

```python
import importlib.util, sys
from pathlib import Path

def _layout():
    name = "cad_record_layout"
    if name not in sys.modules:
        path = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"
        spec = importlib.util.spec_from_file_location(name, path)
        sys.modules[name] = importlib.util.module_from_spec(spec)  # dataclasses look the module up here
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]
```

Every function takes `hw`, the record's `hw/` folder. Results and errors give project-relative paths
(`hw/...`, `.cad-work/...`), except where a function returns a `Path`. A rejected input raises
`LayoutError`.

## Resolve paths

| Call | Returns |
|---|---|
| `version_dir(hw, "v3")` | `hw/versions/v3` |
| `manufacturing_dir(hw, "v3", "LMP-0001")` | `hw/versions/v3/manufacturing/LMP-0001` |
| `bundle_dir(hw, kind, "v3", subject)` | `hw/<kind>/v3/<subject>`, for a `kind` from `bundle_kinds()` |
| `resolve(hw, entry_id, **tokens)` | the path of any entry, such as `resolve(hw, "record.part_sources", PN="LMP-0005")` |
| `versions(hw)` | the built labels, oldest first |
| `latest(hw)` | the label in `versions/latest.json`, or `None` when the file is absent |
| `next_version(hw)` | the label of the next `cad-model run` |
| `classify(path, hw=None)` | a `Match` (`entry`, `params`, `name`, `role`), or `None` |

`bundle_kinds()` is checks, drawings, renders, captures, motion and analysis. `latest` raises
`LayoutError` when the label it names is not built. `classify` reads `path` as project-relative.
Pass `hw` to classify a filesystem path.

The resolvers check every token value against its grammar. A wrong PN, version or subject raises
`LayoutError`. Use the resolvers instead of joining path strings.

## Publish a bundle

A bundle is one sealed folder per version and subject: the `bundle.*` entries and
`concept.screenshot`. Write it with `staging` and `publish`:

```python
staged = layout.staging(hw, "bundle.renders")            # .cad-work/publication/bundle.renders-<uuid>/
(staged / "iso.png").write_bytes(png)                    # only names the entry lists
result = layout.publish(hw, "bundle.renders", {"V": "v3", "S": "assembly"}, staged,
                        recipe={"views": ["iso"], "size": [1600, 1200], "renderer": "cad-render 1"},
                        producer="cad-render render.py", status="pass", replace=args.replace)
```

`publish` does these steps:

1. It checks the staged file names against the entry and hashes every file.
2. It binds the sha256 of `hw/versions/<V>/manifest.json`.
3. It writes `manifest.json` to `schemas/bundle-manifest.schema.json`.
4. It claims the target with an exclusive `mkdir` and renames the staging folder onto it.

Readers see either no bundle or a complete one. Two writers cannot both claim one path.

The recipe is a JSON object. Put every input that must make a different bundle in it:

- tool versions
- effective options, such as views, size, pose or tolerances
- the selected part and case inputs

Keep wall time, ports, absolute paths and random ids out of it.

When the bundle exists, `publish` does one of three things:

- Same `recipe_sha256` and version manifest, and the bundle verifies: it deletes the staging folder
  and returns the existing bundle with `result.reused` set.
- Any other bundle, without `replace`: it raises `PublishConflict`.
- Any other bundle, with `replace=True`: it moves the old bundle to
  `.cad-work/replaced/<path>/<stamp>/` (`result.replaced`). The new manifest's `replaces` records the
  old manifest sha256, the old recipe sha256 and the new location.

Expose `replace` as the command's `--replace` flag. After a failure the staging folder stays in
`.cad-work/` as scratch, and the bundle path keeps its old content.

Before you use a bundle or a version as input, call `verify(directory)`. It returns a list of
problems against the manifest inventory. An empty list means the folder verifies. It also reads a
v2 release manifest, whose `files` map each path to its `sha256` and `original`.

`release.py` writes a sealed directory that is not a bundle. Such a writer stages under `.cad-work/`
and lands with `claim(staged, target, target_rel)`. `claim` takes the target with an exclusive
`mkdir` and renames the stage onto it. A target that exists raises `PublishConflict`, and the stage
stays where it is. `publish` lands bundles the same way.

## Write a producer command

A command that publishes a bundle from a built version uses three more calls, so producers share
one behaviour:

- `built_version(hw, requested)` takes `--version` (a label or `latest`) and returns
  `(label, version folder, record snapshot folder)`. It raises `LayoutError` when the version is not
  built, fails its manifest or has no `record/` snapshot. Read part, interface and assembly records
  from the snapshot, not from the current `hw/` files.
- `reusable(hw, entry_id, params, recipe, replace=False)` runs before the expensive work. It returns
  the bundle `publish` would return unchanged, or `None` when there is nothing to reuse. Another
  recipe raises `PublishConflict` unless `replace`.
- `scratch_path(hw, path, option)` checks an explicit output override such as `--out`. It accepts
  only a path under `.cad-work/`; `option` names the flag in the error.

## Read the manufacturing contract

`custom_made(part)` is true when `make_buy` is `make` or `procurement.mode` is `made_to_drawing`.
A catalogue buy returns false.

`manufacture_policy(part)` returns the contract of a custom-made part record:

- `outputs`: the file names under `manufacturing/<PN>/` for its process. FDM gets `part.step`,
  `part.stl` and `manufacturing.json`. CNC and made-to-drawing parts get `part.step` and
  `manufacturing.json`.
- `linear_deflection_mm` and `angular_deflection_rad`: the STL tessellation, 0.05 mm and 0.1 rad
  by default. part.yaml `manufacture.mesh` overrides them.
- `relationship`, `state`, `reason` and `decision`: from part.yaml `manufacture`.
- `volume_tolerance_mm3(installed_volume)`: the allowed volume difference. A part made in its
  installed shape gets 1e-9 relative. A part with a `different` state gets its declared tolerance.

## Read the git storage rules

`git_storage(results_in_git)` returns `{".gitignore": [...], ".gitattributes": [...]}`, the rules for
product.yaml `storage.results_in_git`, relative to `hw/`. `True` gives Git LFS attribute lines for
the STEP and GLB files of every result folder and no ignore lines. `False` and `None` (not asked)
give one ignore line per result folder and no attribute lines. `result_root(rel)` names the result
folder that holds `rel`, a path below `hw/`, such as `motion/v3`, or returns `None`. cad-flow
`setup.py --storage` writes the rules; [layout.md](layout.md) "Git storage" lists them.

## Audit a record

`audit(hw, references)` walks every file and folder under `hw/`, including untracked and ignored
files. It does not follow symlinks. It returns `Audit(problems, bundles)`.

Each `Problem` has these fields:

- `code`, `path` and `message`
- `action` and `canonical_location`
- `severity`: `stage`, `warning` or `error`

`validate.py` turns `stage` into a warning or an error from the product's stage and frozen anchor.
To decide whether a validation report fails, call `validate.blocking(findings)`. It returns the
errors and keeps the warnings out.
