# Upstream guidance for ui-microcopy

The merged skill incorporates UX writing guidance vendored from `anthropics/knowledge-work-plugins`, Apache-2.0. The upstream material is retained in `references/copy-guidance.md` and adapted to this repository's skill contract.

## Attribution obligations we carry

Apache-2.0 sections 4(a) through 4(d) apply because the vendored guidance is modified. The package therefore ships `LICENSE` and `NOTICE` beside the merged skill and records the modification in `SKILL.md`.

The modification is necessary because upstream guidance referred to a design-source connector that does not exist here. The merged reference instead directs agents to `skill://design-system-audit` and `skill://ui-review`.

## Not routed to

`impeccable clarify` is deliberately not used. It lacks an onboarding-copy surface, a structured deliverable pairing recommended copy with tone-tagged alternatives plus rationale and localization notes, a requester input checklist, and a success, error, warning, neutral tone map.

Other upstream UX-writing packages are displaced by the merged skill.
