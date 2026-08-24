---
config: user-journeys/1
reporter: local            # github-issues | local | none
reporter_labels: []        # extra labels when reporter is github-issues
fix_loop: dispatch-coder   # report-only | dispatch-coder | fix-direct
fix_loop_max_iterations: 3
runs_keep: 20
---

# User journeys

End-to-end user journeys for this product: what a user does, what they must
observe, validated against the running product. `FORMAT.md` is the spec for
every file in this directory; `INDEX.md` is the generated routing table
(from this directory, regenerate with `python3 journeys.py index .`; never
hand-edit). This file is the
per-project configuration -- frontmatter holds the settings, the sections
below hold the guidance agents need to run journeys here.

## Interface profiles

One subsection per interface named in journey frontmatter `interfaces:`.
`kind` and `exclusive` are structured; everything else is free-form guidance
for the validating agent -- launch/reset commands, doc pointers, fixtures,
known quirks. Concrete bindings (selectors, commands per step) are never
stored; the agent resolves driving strategy from this plus the project docs.

### example-ui
- kind: web              <!-- web | desktop-mcp | cli | tui | api -->
- exclusive: false       <!-- true = one validator at a time on this profile -->

Replace me: how to launch and reset the product, which driver to prefer
(e.g. Playwright against `pnpm dev` on :5173), where fixtures live, what
must never be done against this environment. State how state/fixture
leakage into the checkout is PREVENTED (gitignore entry, temp working dir,
pre-run assertion) -- a convention alone is not a guarantee.

## Surface map

Maps changed file paths to journey `surfaces:` names for changed-only
validation. Optional -- agent judgment bridges anything unmapped.

| path glob | surfaces |
|---|---|
<!-- | `src/features/checkout/**` | checkout | -->

## Intent-evidence sources

Where an agent should look for proof that a behavior change was intentional
(amendment gating, see FORMAT.md): merged PRs, changelog, specs, ADRs --
list this repo's actual conventions and locations here.

## Notes

Anything else journey authors and validators should know in this repo.
