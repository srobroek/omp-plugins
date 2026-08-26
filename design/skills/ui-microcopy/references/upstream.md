# Upstream routes for ui-microcopy

`ux-copy` is VENDORED into this package at `design/skills/ux-copy/`, so it needs no
install and cannot be missing. That is deliberate, and the reason is worth recording.

## Why it is vendored rather than advertised

It comes from `anthropics/knowledge-work-plugins`, Apache-2.0 with a LICENSE file, as a
single 107-line `SKILL.md` with no scripts and no references.

Installing that repository as a catalog entry would also expose four displaced skills:
`design-critique` (117 lines), `design-system` (190), `design-handoff` (131), and
`accessibility-review`. Each is a review template written around a Figma connector, and
each is displaced here: critique belongs to the `design-critic` agent, design systems to
`skill://design-system-audit`, and accessibility to `skill://accessibility-audit`.

One 107-line file was worth carrying. Four displaced review templates were not, and
skill granularity is the whole plugin, so there is no way to take one and leave four.

## Attribution obligations we carry

Apache-2.0 sections 4(a) through 4(d) apply, because the vendored file is modified. The
package therefore ships:

- `design/skills/ux-copy/LICENSE`, the full Apache-2.0 text.
- `design/skills/ux-copy/NOTICE`, naming the upstream project, its repository, its
  copyright holder, and the date of the copy.
- A modification notice in the file itself, stating what was changed.

The modification is small and necessary: upstream links to `../../CONNECTORS.md`, which
describes a design-source connector that does not exist here. The link is replaced with
one line putting connectors out of scope. A dangling relative link would fail this
repository's own contract check.

## Not routed to

`impeccable clarify` covers adjacent ground and is deliberately not used. It lacks an
onboarding-copy surface, a structured deliverable pairing recommended copy with three
tone-tagged alternatives plus rationale and localization notes, a requester input
checklist, and a success, error, warning, neutral tone map.

`ss-copy` from `bitjaru/styleseed` and `ux-writing` from `Owl-Listener/designer-skills`
are both displaced by `ux-copy`.
