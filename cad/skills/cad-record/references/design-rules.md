# Design rules

`scripts/design_rules.py` holds the record's design rules. `validate.py` runs them on the schema-valid record, and each finding carries a stable `code`.

## Clearance margin

A measured distance below a clearance requirement's `min_clearance_mm` fails. A distance at or above the minimum but below minimum + margin is a `margin` warning, never a failure.

- The margin is the interface's `margin_mm`, else product.yaml `design.clearance_margin_mm`, else 0.1 mm.
- cad-model check and cad-motion sweep read it through one loader: `load_clearance_margins(record_dir)`, where `record_dir` is `hw/` or a version's `record/` snapshot. `clearance_margins(product, interfaces)` takes already parsed documents.
- Both return `ClearanceMargins`: `.default_mm`, `.by_interface` (clearance interface id to margin), and `.for_interface(id)`, where `None` names a global minimum and an unknown id raises KeyError.
- A malformed margin raises ValueError; it never falls back to the default.
- Load the module by path as `cad_record_design_rules` and register it in `sys.modules` before running it. It needs PyYAML and the standard library only.

## Retention

Codes `retention.torque_path` and `retention.axial_retainer`. Both are errors from stage `parts` (L2) on and are not reported before it.

- A drive train is a revolute joint that is coupled, drives a coupling or mechanism, or is declared `torque: transmitted`. Its child and that child's fixed-joint descendants form one rotating body.
- Every fixed joint inside that body declares `torque`: `transmitted` with a `torque_path`, or `none`. A hand-positioned revolute is exempt.
- Any joint declared `transmitted` needs a `torque_path`: `key`, `set_screw`, `d_flat`, `press_fit`, `spline`, `clamp`, `pin` or `adhesive`.
- Every `press_fit` and `locating_fit` needs an `axial_retainer`: `shoulder`, `circlip`, `set_screw`, `nut`, `pin`, `cap`, `captured`, `press_fit` or `adhesive`. A `press_fit` retainer is valid on a press fit only. A `running_fit` is a motion fit and is exempt.
- A hardware torque path (`key`, `set_screw`, `pin`) or hardware retainer (`circlip`, `set_screw`, `nut`, `pin`, `cap`) names its modelled occurrences in `parts`, and each must resolve to one occurrence. A decision record naming hardware nobody modelled does not count.
- `decision: DR-###` links either one to the decision record that chose it.

## Process feasibility

Code `feasibility.transparent_fdm`: a warning before stage `parts`, an error from `parts` on. FDM prints translucent, not see-through. The rule flags:

- an FDM part declared `transparency: transparent`;
- an FDM part with no `transparency` whose `material` or `finish` names a clear material, such as "clear PETG";
- a requirement whose text or verification criteria ask for a transparent or see-through element, when FDM is planned (`manufacturing.processes` or any part) and no purchased or CNC part declares `transparency: transparent`. This one shows from INTENT on, before any part exists.

Resolve each with a decision record and a record change: a bought or machined transparent part, `transparency: translucent`, or a reworded requirement.

## Visibility bindings

A requirements.yaml entry's optional `visibility` lists show-the-motion checks, each `{view, window, targets, min_visible_fraction}`:

- `view` is a cad-render view: `iso`, `front`, `side`, or `dir-X-Y-Z` in assembly coordinates.
- `window` and `targets` are disjoint, non-empty lists of part references (a PN placed once, or `@occurrence`).
- `min_visible_fraction` is in (0, 1]; absent means 0.5.

Rendering only the window and target parts, from `view` at the nominal pose, the visible share of the targets' projected area must reach `min_visible_fraction`. Only window parts declared `transparency: transparent` are see-through.

Code `visibility.binding`: an error at every stage when a window or target part does not resolve to one occurrence, or one part is both. cad-render reads the bindings through `visibility_bindings(requirements)`, which returns `VisibilityBinding(requirement, index, view, window, targets, min_visible_fraction)` with the 0.5 default applied.
