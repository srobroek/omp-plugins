# CAD `hw/` layout

Generated from `layout.json` by `python3 scripts/layout.py --markdown`. Edit `layout.json`, then regenerate
this file; a cad-record test fails when the two disagree. Commands that read or write these paths use the
API in [layout-api.md](layout-api.md).

Paths are relative to the project root, the folder that holds `hw/`. `{TOKEN}` stands for a value of the
token's grammar; `**` stands for one or more nested names. A path ending in `/` is a folder that holds the
listed files and nothing else.

## Tokens

| Token | Grammar | Example | Meaning |
|---|---|---|---|
| `{V}` | `v[1-9][0-9]*` | `v3` | cad-model version label |
| `{PN}` | `[A-Z]{2,5}-[0-9]{4}` | `LMP-0002` | part number |
| `{S}` | `[A-Z]{2,5}-[0-9]{3,4}\|[a-z][a-z0-9_-]*` | `assembly` | bundle subject: a PN, a record id such as a stack-up (STK-101), a subassembly, check or case id, or assembly for the whole product |
| `{ID}` | `[a-z][a-z0-9_-]*` | `arm-load` | analysis case id |
| `{REV}` | `[A-HJ-NPRTUVWY]` | `A` | released revision letter |
| `{DR}` | `DR-[0-9]{3}` | `DR-001` | decision record id |
| `{N}` | `[1-9][0-9]*` | `1` | sheet number |
| `{VIEW}` | `[a-z][A-Za-z0-9_-]*` | `part-LMP-0001` | render or capture view name; per-part views carry the PN |
| `{PRODUCT}` | `[a-z0-9][a-z0-9-]*` | `lamp-arm` | product id from product.yaml |
| `{SCENE_SHA}` | `[0-9a-f]{64}` | `1111111111111111111111111111111111111111111111111111111111111111` | sha256 of the concept scene file |
| `{CAPTURE_SHA}` | `[0-9a-f]{64}` | `2222222222222222222222222222222222222222222222222222222222222222` | sha256 of the captured viewer state |
| `{PID}` | `[0-9]+` | `4242` | process id of the writing run |
| `{STAMP}` | `[0-9]+` | `1730000000` | monotonic clock stamp of the writing run |
| `{NAME}` | `[^/]+` | `notes.md` | one file or directory name |

## Paths

| Id | Path | Kind | Files (role) | Writer | Appears at | Mutability | Meaning |
|---|---|---|---|---|---|---|---|
| `record.product` | `hw/product.yaml` | record | (source) | lead (cad-record workflow) | ground | controlled | product identity, rigor, regime, tolerances and workflow state, including the frozen anchor |
| `record.requirements` | `hw/requirements.yaml` | record | (source) | lead (cad-record workflow) | specify | controlled | REQ-### requirements with verification methods |
| `record.interfaces` | `hw/interfaces.yaml` | record | (source) | lead (cad-record workflow) | specify | controlled | mating, motion, clearance and fit contracts |
| `record.assembly` | `hw/assembly.yaml` | record | (source) | lead (cad-record workflow) | layout | controlled | subassemblies, occurrences and joints |
| `record.bom` | `hw/bom.csv` | generated | (data) | cad-bom bom.py, reconciled by the lead | layout | regenerated | hierarchical EBOM; the part records stay the authority |
| `record.verification` | `hw/verification.csv` | record | (source) | lead | specify | controlled | verification status and evidence links per requirement |
| `record.decision` | `hw/decisions/{DR}.md` | record | (source) | lead | ground | append_only | dated decision rationale and approvals |
| `record.docs` | `hw/docs/` | record | `**` (document; never geometry or script) | user or lead | ground | free | human notes, guides and reference material |
| `record.part` | `hw/parts/{PN}/` | record | `part.yaml` (source), `model.py` (source, optional) | lead; a worker through cad-flow scratch.py deliver | layout | controlled | one part record and its parametric model |
| `record.part_sources` | `hw/parts/{PN}/sources/` | record | `**` (evidence) | lead, accepting sourcing evidence | parts | controlled | frozen procurement copies (datasheets, certificates, vendor models) that part.yaml procurement names with their sha256 |
| `record.concept_scene` | `hw/concept/{PRODUCT}.scene.json` | record | (source) | lead, merging concept variants | concept | controlled | L0 concept variants and rough primitives |
| `concept.handoff` | `hw/concept/handoff.json` | generated | (data) | cad-concept concept.py handoff | concept | regenerated | the chosen variant, bound to the scene's sha256 |
| `concept.screenshot` | `hw/concept/screenshots/{SCENE_SHA}/{CAPTURE_SHA}/` | generated, sealed by its bundle manifest | `preview.png` (review), `manifest.json` (manifest) | cad-concept serve.py screenshot | concept | immutable | one concept preview bound to its scene and viewer state; no engineering credit |
| `record.analysis_case` | `hw/analysis/cases/{ID}/` | record | `case.yaml` (source), `**` (source, optional) | lead, accepting an analyst proposal | analysis | controlled | one analysis case and the input files it declares |
| `record.motion_case` | `hw/motion/cases/{ID}/` | record | `plan.yaml` (source) | lead, accepting an analyst motion plan | analysis | controlled | one authored motion plan over the record's independent joints; the default plan is generated, and the case id default is reserved |
| `version.core` | `hw/versions/{V}/` | generated, sealed by its version manifest | `assembly.step` (definition), `assembly.glb` (review), `part-map.json` (data), `metrics.json` (data), `drawing-features.json` (data, optional), `manifest.json` (manifest), `parts/{PN}.step` (definition) | cad-model cad_model.py run | layout | immutable | one built version; its manifest.json inventories every file below it, including record/ and manufacturing/ |
| `version.record` | `hw/versions/{V}/record/` | generated | `product.yaml` (snapshot), `interfaces.yaml` (snapshot), `assembly.yaml` (snapshot), `parts/{PN}/part.yaml` (snapshot) | cad-model cad_model.py run | layout | immutable | the record files the version was built from, for readers of the old state |
| `version.manufacturing` | `hw/versions/{V}/manufacturing/{PN}/` | generated | `part.step` (manufacture), `part.stl` (manufacture, optional), `manufacturing.json` (data) | cad-model cad_model.py run | layout | immutable | the final manufacturing geometry of one custom-made part; complete for every custom-made PN by design_freeze |
| `version.latest` | `hw/versions/latest.json` | generated | (navigation) | cad-model cad_model.py run | layout | pointer | names the newest complete version |
| `bundle.checks` | `hw/checks/{V}/{S}/` | generated, sealed by its bundle manifest | `result.json` (data), `manifest.json` (manifest) | cad-model check, cad-design form_check.py, cad-fits stackup.py result adapters | layout | immutable | one check result for one version and subject; a failed result is never reused as a pass |
| `bundle.drawings` | `hw/drawings/{V}/{S}/` | generated, sealed by its bundle manifest | `sheet-{N}.svg` (document), `sheet-{N}.pdf` (document), `sheet-{N}.png` (review), `coverage.json` (data), `package.json` (data), `manifest.json` (manifest) | cad-drawings drawing.py, assembly_drawing.py | detail | immutable | one controlled drawing package; rejected drafts stay in .cad-work |
| `bundle.renders` | `hw/renders/{V}/{S}/` | generated, sealed by its bundle manifest | `{VIEW}.png` (review), `render.json` (data, optional), `manifest.json` (manifest) | cad-render render.py | layout | immutable | one review render set |
| `bundle.captures` | `hw/captures/{V}/{S}/` | generated, sealed by its bundle manifest | `{VIEW}.png` (review), `capture.json` (data, optional), `manifest.json` (manifest) | cad-viewer viewer.py capture | layout | immutable | viewer captures of exactly the displayed version and state |
| `bundle.motion` | `hw/motion/{V}/{S}/` | generated, sealed by its bundle manifest | `pose.step` (evidence, optional), `worst.step` (evidence, optional), `worst.step.json` (data, optional), `evidence/**` (evidence, optional), `plan.json` (data, optional), `coverage.json` (data, optional), `motion.glb` (review, optional), `contact-sheet.png` (review, optional), `video.mp4` (review, optional), `frames/**` (review, optional), `crosscheck.json` (evidence, optional), `result.json` (data), `manifest.json` (manifest) | cad-motion pose.py, sweep.py, freecad_assembly.py, motion.py | analysis | immutable | one kinematic case: posed or worst-case geometry, or a motion render, and its result |
| `bundle.analysis` | `hw/analysis/{V}/{S}/` | generated, sealed by its bundle manifest | `results.json` (data), `evidence/**` (evidence, optional), `manifest.json` (manifest) | cad-analysis fea_static.py, an accepted stack-up adapter | analysis | immutable | one analysis case result with every retained solver file |
| `release.package` | `hw/releases/{REV}/` | generated, sealed by its release manifest | `manifest.json` (manifest), `definition/**` (definition, optional), `manufacturing/**` (manufacture, optional), `drawings/**` (document, optional), `analysis/**` (evidence, optional), `checks/**` (evidence, optional), `motion/**` (evidence, optional), `bom.csv` (snapshot, optional), `verification.csv` (snapshot, optional), `docs/**` (document, optional) | cad-record release.py (lead) | release | immutable | a sealed release package; a used revision is never overwritten |
| `control.recheck` | `hw/.cad/recheck.json` | generated | (control) | cad-recheck stamp.py | layout | regenerated | stamp bound to the staged hw/ tree; any staged change invalidates it |
| `scratch` | `.cad-work/` | scratch | `**` (scratch) | cad-flow scratch.py, scoped workers, layout.py publication staging | any | scratch | drafts, jobs, logs, publication staging and replaced bundles, beside hw/ |

## Kinds

| Value | Meaning |
|---|---|
| `record` | authored source the lead controls; the design is defined here |
| `generated` | written by the named command from the record; never edited by hand |
| `scratch` | drafts and staging beside hw/; never record evidence |

## Mutability

| Value | Meaning |
|---|---|
| `controlled` | changed through the record workflow; after design_freeze only by an approved change (flow.change) |
| `regenerated` | rewritten by its writer whenever its inputs change |
| `append_only` | add or supersede; never rewrite an approval |
| `free` | edited freely; earns no geometry, check or release credit |
| `immutable` | sealed once written; a changed input makes a new version or, with --replace, a new bundle |
| `pointer` | repointed by its writer to the newest complete version; not an approval |
| `scratch` | disposable work space; nothing in it counts until published |

## Roles

| Value | Meaning |
|---|---|
| `source` | authored input |
| `data` | machine-readable result |
| `document` | human-readable document |
| `evidence` | retained supporting file |
| `review` | preview image for review |
| `definition` | installed (as-assembled) geometry |
| `manufacture` | final geometry in its manufacturing state |
| `manifest` | the inventory that seals its directory |
| `snapshot` | copy of a record file at build or release time |
| `navigation` | pointer to another location |
| `control` | workflow control state |
| `scratch` | draft or staging file |

## Accepted exceptions

These paths are not part of the layout but have a known writer. `transient` and `metadata` paths are
reported with the action below; `vcs` paths are accepted.

| Path | Kind | Writer | Action |
|---|---|---|---|
| `hw/versions/.{V}.partial-{PID}`/ | transient | cad-model cad_model.py run | An interrupted cad-model run left this staging folder. Delete it once no run is in progress. |
| `hw/versions/.latest.json.tmp` | transient | cad-model cad_model.py run | An interrupted cad-model run left this temporary pointer. Delete it once no run is in progress. |
| `hw/renders/.{V}.partial-{STAMP}`/ | transient | cad-render render.py | An interrupted render left this staging folder. Delete it once no render is in progress. |
| `hw/renders/.{V}.old-{STAMP}`/ | transient | cad-render render.py | An interrupted render left the set it was replacing. Delete it once no render is in progress. |
| `hw/.cad/.recheck.json.tmp` | transient | cad-recheck stamp.py | An interrupted stamp left this temporary file. Delete it once no stamp is in progress. |
| `hw/**/.DS_Store` | metadata | macOS Finder | Operating-system metadata, not a CAD file. Delete it and ignore it in git. |
| `hw/**/Thumbs.db` | metadata | Windows Explorer | Operating-system metadata, not a CAD file. Delete it and ignore it in git. |
| `hw/parts/{PN}/__pycache__`/ | metadata | a Python import of model.py | Python bytecode from a direct import of model.py. Delete it; cad-model runs model.py with bytecode writing off. |
| `hw/.git` | vcs | git | Repository metadata; not walked. |
| `hw/**/.gitignore` | vcs | user or lead | Repository metadata; accepted. |
| `hw/**/.gitattributes` | vcs | user or lead | Repository metadata; accepted. |
| `hw/**/.gitkeep` | vcs | user or lead | Placeholder that keeps an empty directory in git; accepted. |

## Misplaced and legacy paths

| Path | Finding | Canonical location | Action |
|---|---|---|---|
| `hw/**/.cad-work`/ | `layout.nested_scratch` | `.cad-work/` | Scratch lives in the project's .cad-work/ beside hw/, never inside it. Move the tree there; nothing in it counts as record evidence. Nothing was changed. |
| `hw/drawings/{PN}/**` | `layout.legacy` | `hw/drawings/<V>/{PN}/` | Regenerate the drawing with cad-drawings for a built version, or migrate it explicitly with its provenance; never guess the version from file dates. Nothing was changed. |
| `hw/renders/{V}/{NAME}` | `layout.legacy` | `hw/renders/{V}/<subject>/` | Renders are one sealed bundle per version and subject. Re-render the version with cad-render, then delete this flat set after review. Nothing was changed. |
| `hw/captures/{V}/{NAME}` | `layout.legacy` | `hw/captures/{V}/<subject>/` | Captures are one sealed bundle per version and subject. Capture again with cad-viewer, then delete this flat set after review. Nothing was changed. |
| `hw/concept/screenshots/{NAME}` | `layout.legacy` | `hw/concept/screenshots/<scene-sha256>/<capture-sha256>/` | Concept previews are bundles bound to their scene and state. Take the screenshot again with cad-concept serve.py, then delete this one after review. Nothing was changed. |
| a file part.yaml `procurement/specification/artifact` names | `layout.misplaced` | `hw/parts/{PN}/sources/{NAME}` | Move the file to hw/parts/{PN}/sources/ and update procurement/specification/artifact in hw/parts/{PN}/part.yaml; its sha256 is unchanged. Nothing was changed. |

## Stray files

Any other file is a `layout.stray` finding. Its suffix picks the class and the suggested location;
`{PN}` is the first part number in the stray path, `{NEXT}` the next version label and `{REL}` the path
below `hw/`.

| Class | Suffixes | Canonical location | Action |
|---|---|---|---|
| geometry | `.step`, `.stp`, `.stl`, `.3mf`, `.glb`, `.gltf`, `.brep`, `.brp`, `.iges`, `.igs`, `.obj`, `.ply`, `.fcstd`, `.dxf`, `.dwg`, `.amf` | `hw/versions/{NEXT}/manufacturing/{PN}/{FILE}` | Geometry is generated, never placed by hand. Define the state in hw/parts/{PN}/model.py; cad-model run writes hw/versions/{NEXT}/manufacturing/{PN}/part.step, and part.stl for an FDM part. Keep any one-off exporter outside hw/, for example in .cad-work/migration/. Nothing was changed. |
| script | `.py`, `.sh`, `.bash`, `.zsh`, `.fcmacro`, `.js`, `.mjs`, `.ts`, `.ipynb`, `.bat`, `.ps1` | `.cad-work/migration/{REL}` | hw/parts/<PN>/model.py is the only CAD source in hw/. Fold the behaviour into the part's model.py, or keep the script outside hw/, for example in .cad-work/migration/. Nothing was changed. |
| document | `.md`, `.txt`, `.rst`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.csv`, `.tsv`, `.xlsx`, `.xls`, `.ods`, `.docx`, `.doc`, `.odt`, `.html`, `.htm` | `hw/docs/{REL}` | Move human notes and reference material to hw/docs/; nothing there earns geometry, check or release credit. Nothing was changed. |
| data | any other | `.cad-work/migration/{REL}` | If a CAD command produced it, run that command again so the output lands in its bundle; otherwise keep it outside hw/, for example in .cad-work/migration/. Nothing was changed. |

## Finding codes

`validate.py` reports each layout finding with `code`, `path`, `canonical_location` and `action`.
A `stage` finding is a warning before `design_freeze` and an error from `design_freeze` on. It stays an
error at every stage once `product.yaml` `flow.frozen` is set or a release manifest exists, and when
the stage is missing or unknown. Errors fail validation (exit 1); warnings are reported and do not.

| Code | Severity | Meaning |
|---|---|---|
| `layout.stray` | stage | a path no layout entry, exception or rule accepts; its class says where it belongs |
| `layout.misplaced` | stage | a recognised file in the wrong place |
| `layout.legacy` | stage | an output from an older layout; regenerate it |
| `layout.nested_scratch` | stage | a .cad-work tree inside hw/ |
| `layout.foreign` | stage | a file inside a bundle or version directory that its entry does not hold |
| `layout.empty_directory` | stage | an empty directory no layout entry names |
| `layout.transient` | stage | a leftover from an interrupted writer |
| `layout.symlink` | stage | a symlink to a path inside hw/; managed paths are real files |
| `layout.unsealed` | stage | a bundle or version directory without its manifest.json |
| `layout.metadata` | warning | operating-system or tool metadata |
| `layout.unsafe_path` | error | a name with control characters, backslashes, undecodable bytes or edge whitespace, or a special file |
| `layout.symlink_escape` | error | a symlink that resolves outside hw/ |
| `layout.unlisted` | error | a file inside a sealed directory that its manifest does not list |
| `layout.missing` | error | a file a sealed manifest lists that is absent |
| `layout.malformed_manifest` | error | a sealing manifest that cannot be read, or that names another place or build |

## Manufacturing outputs

A part is custom-made when `make_buy: make` or `procurement.mode: made_to_drawing`; catalogue buys are not. Every custom-made PN gets
`hw/versions/{V}/manufacturing/{PN}/` with these files, by process:

| Process | Files |
|---|---|
| fdm | `part.step`, `part.stl`, `manufacturing.json` |
| cnc | `part.step`, `manufacturing.json` |
| purchased | `part.step`, `manufacturing.json` |

| File | Format |
|---|---|
| `part.step` | STEP AP242, exact B-rep, millimetres |
| `part.stl` | binary STL, millimetres |

The STL tessellation defaults to 0.05 mm linear and 0.1 rad angular deflection; part.yaml `manufacture.mesh` overrides it per
part. A part made in its installed shape compares the manufactured volume to the installed one within
1e-09 relative. A part with `manufacture.relationship: different`
declares its own `volume_rel_tolerance` or `volume_abs_tolerance_mm3`.
