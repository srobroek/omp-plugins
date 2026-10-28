# Producer-ready part drawings: standards rows

Distilled from the project's producer-ready checklist (research position 27 October 2026). MUST is
the floor for manufacture, inspection and procurement without clarification; SHOULD is strongly
recommended. Citing a standard is not proof of conformance, and the full standards are
copyrighted: verify clause details against the edition the order invokes. The last column names
what `drawing.py` checks; everything else needs human review of the PNG preview.

| Row | Level | ISO | ASME | Generated check |
|---|---|---|---|---|
| Identity, revision, title, units, one regime; model, drawing and BOM agree | MUST | [ISO 7200](https://www.iso.org/standard/35446.html), [ISO 16792](https://www.iso.org/standard/73871.html) | [Y14.100](https://www.asme.org/codes-standards/find-codes-standards/y14-100-engineering-drawing-practices), [Y14.35](https://www.asme.org/codes-standards/find-codes-standards/y14-35-revision-engineering-drawings-associated-documents) | title block from part.yaml; `drawing_contract` hashes; PDF text read back |
| Authoritative definition stated: model plus drawing | MUST | [ISO 16792](https://www.iso.org/standard/73871.html), [ISO 1101](https://www.iso.org/standard/66777.html) | [Y14.41](https://www.asme.org/codes-standards/find-codes-standards/y14-41-digital-product-definition-data-practices) | model note with the STEP name and sha256 when a controlled-model profile is used |
| Material, process and finish | MUST | [ISO 7573](https://www.iso.org/standard/43883.html) | [Y14.100](https://www.asme.org/codes-standards/find-codes-standards/y14-100-engineering-drawing-practices) | material in the title block; `finish` note required |
| Sufficient views, sections, details; declared projection | MUST | [ISO 128-3](https://www.iso.org/standard/83356.html), [ISO 5456-2](https://www.iso.org/standard/11502.html) | [Y14.3](https://www.asme.org/codes-standards/find-codes-standards/y14-3-orthographic-pictorial-views) | projection symbol; each annotation ends on visible geometry of its feature (`feature_not_presentable`) |
| Every cut face of a section shown as cut; one part lined alike in all its faces, in proportion to its size, or solid when very thin | MUST | [ISO 128-3](https://www.iso.org/standard/83356.html), which replaced [ISO 128-50](https://www.iso.org/standard/24240.html) | [Y14.3](https://www.asme.org/codes-standards/find-codes-standards/y14-3-orthographic-pictorial-views) | `section_hatch`: each face's fill shows its projected area within 1 %; per part one fill, at least 3 lines at 0.7 mm or more across a lined part, solid only under 2.1 mm; see Section fills |
| Every functional and inspection dimension defined; functional sizes shown directly | MUST | [ISO 129-1](https://www.iso.org/standard/64007.html) | [Y14.5](https://www.asme.org/codes-standards/find-codes-standards/dimensioning-and-tolerancing) | feature-kind requirements, face inventory, axial-end closure (`dimension_coverage_incomplete`, `geometry_unaccounted`); recognised features on the B-rep (`feature_coverage`): wall, rib and shell thickness, pocket, cutout, notch, slot and groove sizes and contour radii stated directly, one finding per undimensioned feature |
| Stated scale, standard sheet, legible lettering | SHOULD; MUST where scaled print matters | [ISO 5455](https://www.iso.org/standard/11500.html), [ISO 5457](https://www.iso.org/standard/29017.html), [ISO 3098-1](https://www.iso.org/standard/65679.html) | [Y14.1](https://www.asme.org/codes-standards/find-codes-standards/drawing-sheet-size-and-format), [Y14.2](https://www.asme.org/codes-standards/find-codes-standards/y14-2-line-conventions-lettering) | standard scales only; 2.5 mm lettering on A4/ANSI A, 3.5 mm above; `layout_check` |
| Explicit general or individual tolerances | MUST | [ISO 2768-1](https://www.iso.org/standard/7748.html); ISO 2768 does not cover FDM | [Y14.5](https://www.asme.org/codes-standards/find-codes-standards/dimensioning-and-tolerancing) | named policy per process (`tolerance_policy_inapplicable`); no general value below 0.5 mm (`tolerance_missing`) |
| Functional datums and GD&T where fit or function needs them | MUST when needed | [ISO 1101](https://www.iso.org/standard/66777.html), [ISO 5459](https://www.iso.org/standard/87855.html), [ISO 8015](https://www.iso.org/standard/55979.html) | [Y14.5](https://www.asme.org/codes-standards/find-codes-standards/dimensioning-and-tolerancing) | datums resolve to bound features (`datum_invalid`); frames reference declared datums |
| Fit classes and limits on both mating parts | MUST for fits | [ISO 286-1](https://www.iso.org/standard/45975.html), [ISO 286-2](https://www.iso.org/standard/54915.html) | Y14.5 with ASME B4.2 | endpoint binding (`fit_binding_missing`); cad-fits limits; modelled size inside them (`fit_geometry_mismatch`) |
| Complete thread designation, depth and pilot | MUST if threaded | [ISO 6410-1](https://www.iso.org/standard/12750.html) | [Y14.6](https://www.asme.org/codes-standards/find-codes-standards/y14-6-screw-thread-representation) | designation, pilot diameter and blind full-thread depth (`thread_spec_incomplete`) |
| Edge condition and critical surface texture | MUST where function depends on it | [ISO 13715](https://www.iso.org/standard/61328.html), [ISO 21920-1](https://www.iso.org/standard/72196.html) | [Y14.36](https://www.asme.org/codes-standards/find-codes-standards/surface-texture-symbols) | a detail drawing states `edges` and a general `surface_texture` (`drawing_intent_missing`); each feature's own symbol or edge sizes sit on that feature (`feature_not_presentable`); values are not checked against function |
| Purchased items orderable: designation, manufacturer, part number, specification | MUST per bought item | [ISO 7573](https://www.iso.org/standard/43883.html), [ISO 4762](https://www.iso.org/standard/34460.html) | [Y14.24](https://www.asme.org/getmedia/2d6774a6-0321-4321-9875-67deec5f0341/y14-24-2020-table-of-contents.pdf) | `procurement_incomplete`; a standard part (`procurement.standard`) is identified by its designation |
| FDM material, tolerance, orientation and post-process stated | MUST when function depends on it | [ISO/ASTM 52903-1](https://www.iso.org/standard/67290.html) | [Y14.46](https://www.asme.org/codes-standards/find-codes-standards/y14-46-product-definition-additive-manufacturing-(1)) | FDM limits policy; an interface tighter than it needs a post-processed condition |
| Released SVG/PDF legible and unclipped | MUST | [ISO 128-2](https://www.iso.org/standard/83355.html) | [Y14.2](https://www.asme.org/codes-standards/find-codes-standards/y14-2-line-conventions-lettering) | `layout_check`, Qt export page size and text read-back |

Release readiness is separate from the gate: an `X` revision (`revision_unreleased`), a bought part
with no supplier or an open identity field (`procurement_incomplete`), or an open general surface texture
(`surface_texture_open`) blocks release, not the drawing.

The ISO 21920-1 symbol of a feature is indicated together with its size callout, under the size text and
any feature control frames, on the callout's leader; the general one stands in the notes beside the title
block. The ISO 13715 general indication is written out as a note with the standard's signed sizes.

## Section fills

`section_hatch.py` fills every face the cutting plane leaves on the part as the face's own outer
loop less its own holes, never one even-odd fill over all faces, where overlapping faces would
cancel. Every face of one part in a view takes the same fill: ISO 128-3:2022 hatches a part the
same way in all its sections.

ISO 128-3 chooses the hatch spacing in proportion to the size of the hatched area, never under
0.7 mm, and allows very thin sections to be blackened; ASME Y14.3 allows the same, so both regimes
use one rule. Per part in each section view, on the sheet:

- Typical width `w = 2 · ΣA / ΣP` over the part's cut faces: their net areas over their whole
  boundaries, holes included. A tube's ring gives its wall, a long strip its thickness.
- Lining: thin 0.18 mm lines `s = clamp(w / 3, 0.7, 3.0)` mm apart, so the part gets three lines
  across its typical width, at 45° to its main outline (the direction that carries most of its
  straight boundary; the sheet axes for a part with none, such as a ring), on one grid: a line runs
  on unbroken from one face of the part into the next. A thin wall of a lined part carries only a
  few lines, as on any drawing.
- Solid: a part with `w < 2.1` mm, three times the 0.7 mm minimum, is filled black in every face,
  its holes left open. No narrower part can take three lines at the minimum spacing.
- Different parts: parts whose faces share a boundary take the other 45° direction, and a third
  part touching both also shifts its grid by half a spacing. Part drawings hold one part; the rule
  is there for assembly sections.
- Gate: `section_hatch` fails the sheet when a face's fill does not show the face's projected area
  (its model area at the view scale) within 1 %: a face with no fill or no lining line across it,
  lining that leaves part of a face bare or crosses one of its holes. Per part, it fails faces
  filled more than one way, lining under 0.7 mm or with fewer than three lines across the part's
  typical width, and a part of 2.1 mm or more filled solid. A section that cuts no material fails
  too.
