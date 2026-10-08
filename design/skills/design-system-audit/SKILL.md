---
name: design-system-audit
description: Inventories existing design tokens, scales, and primitives before UI work. Triggers on what tokens does this project use, is there a design system.
---

# Design System Audit

Phase GROUND. Report the system that exists. Never invent it.

TRIGGER
+ before implementing, restyling, or reviewing UI in an unfamiliar repo
+ "what tokens does this project use", "is there a design system here"
+ a literal color, radius, or spacing value is about to be written into a component
- recording the system as a durable artifact -> `design-md`
- judging an implemented surface against the system -> `ui-review`

GATES
ASK Creating a token set after an ABSENT verdict. The user approves a new system; the audit never starts one.

## Workflow

1. Route by TASK, not by topic. -> the chosen route is named in the report header.
   - AUDITING an existing system, this skill's own job: `ss-lint` for fast automated
     violation detection, then `ss-review` for design-system compliance review.
   - GENERATING a palette, or adding and modifying tokens: `ss-tokens`. That is its whole
     scope. It declines the audit in its own words, "For finding token violations in
     existing code -> use /ss-lint", so routing an audit there asks a generator for a job
     it says is not its.
   - validating a StyleSeed artifact contract needing file-and-line evidence: `ss-score`,
     which emits `deterministic.json` with detector ids and fix text.
   Every `ss-*` route above ships in the one `styleseed` entry, so the cost is paid once.
2. Apply `rule://design-upstream-preflight` for `styleseed` BEFORE loading the routed
   skill. -> installed and prerequisites probed. A routed name already in your available
   skills: LOAD it via `skill://`. Installed during this session: read its SKILL.md from
   the install path, since `skill://` throws `Unknown skill` until the next session.
   Install refused or failed: do NOT substitute your own inventory for the upstream's
   engine. Report the gap. You MAY still report the grounded carrier inventory from step
   3, labelled as carriers rather than as the upstream's verdict.
3. Locate carriers for the upstream to read: LOAD
   `skill://design-system-audit/references/token-carriers.md` for the per-ecosystem
   `glob` and `grep` patterns. -> a path list; an empty list is the ABSENT verdict, not
   permission to invent.
4. For token build, schema, and contrast pipeline questions, LOAD
   `skill://design-system-audit/references/token-pipeline.md`. -> the canonical source
   and the one tool per job, so no second build authority is introduced.

## Rules

MUST Quote `file:line` for every value reported. An unsourced value is a guess.
MUST Return ABSENT and stop when step 3 finds no carrier.
MUST Resolve a real installed path before running an upstream script. The documented
  `<installed-ss-tokens>/scripts/generate-palette.mjs` and
  `<installed-ss-score>/scripts/styleseed-check.mjs` are literal prose placeholders that
  never expand. Resolve each under the install path the preflight reports.
DEFAULT Label a value `observed` when read from a carrier and `inferred` when derived
  from usage. Later phases treat the two differently.
NOT Propose a token name that `grep` over the carriers would have found.
NOT Report a framework default as a project token unless the config extends it.

OUTPUT
L1 SYSTEM: PRESENT | PARTIAL | ABSENT -- route used, plus the primary carrier.
   Tokens -- group, path, values. Primitives -- name, path, variant mechanism.
   Conflicts -- only if non-empty: token, value A at path, value B at path.
CAP 250w plus the tables
