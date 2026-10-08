# Upstream guidance for ui-microcopy

The merged skill incorporates UX writing guidance vendored from `anthropics/knowledge-work-plugins`, Apache-2.0. The upstream material is retained in `skill://ui-microcopy/references/copy-guidance.md` and adapted to this repository's skill contract.

## Attribution obligations we carry

Apache-2.0 sections 4(a) through 4(d) apply because the vendored guidance is modified. The package therefore ships `LICENSE` and `NOTICE` beside the merged skill and records the modification in `SKILL.md`.

The modification is necessary because upstream guidance referred to a design-source connector that does not exist here. The merged reference instead directs agents to `skill://design-system-audit` and `skill://ui-review`. The upstream's requester-input block was also dropped, because the skill takes its constraints from code and the running surface rather than asking for them.

Other upstream UX-writing packages are displaced by the merged skill. Why `impeccable clarify` is not routed to is stated once, in `SKILL.md`.
