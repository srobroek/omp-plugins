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
ASK Taking the StyleSeed route in step 4 when the user has not asked for it. Its install adds 23 `ss-*` skills to every later session.

## Workflow

1. Locate carriers: LOAD `skill://design-system-audit/references/token-carriers.md` and run
   its `glob` and `grep` patterns for every ecosystem the repository uses, token
   directories first. -> a path list naming each carrier's ecosystem. An empty list after
   every applicable row was searched is the ABSENT verdict; a row left unsearched makes
   the verdict incomplete, never ABSENT.
2. Inventory every carrier the list names. -> each token group with its values quoted at
   `file:line`, its consumption confirmed by a hit outside the carrier, the spacing base
   derived as the reference describes, and every conflict the reference lists. This
   inventory is the audit and its verdict.
3. For token build, schema, and contrast pipeline questions, LOAD
   `skill://design-system-audit/references/token-pipeline.md`. -> the project's existing
   source and builder named, so no second build authority is introduced.
4. OPTIONAL, only when the user asks for StyleSeed or approves it at the gate: LOAD
   `skill://design-system-audit/references/upstream.md`, apply
   `rule://design-upstream-preflight` for `styleseed`, then route by task. -> StyleSeed's
   findings reported beside the inventory and labelled as its own. A refused or failed
   install changes nothing above, because the carrier inventory stays the verdict. A
   routed name already in your available skills: LOAD it via `skill://`. Installed during
   this session: read its SKILL.md from the install path, since `skill://` throws
   `Unknown skill` until the next session.

## Rules

MUST Quote `file:line` for every value reported. An unsourced value is a guess.
MUST Return ABSENT and stop when step 1 finds no carrier.
MUST Resolve a real installed path before running a StyleSeed script. The documented
  `<installed-ss-tokens>/scripts/generate-palette.mjs` and
  `<installed-ss-score>/scripts/styleseed-check.mjs` are literal prose placeholders that
  never expand. Resolve each under the install path the preflight reports.
DEFAULT Label a value `observed` when read from a carrier and `inferred` when derived
  from usage. Later phases treat the two differently.
NOT Propose a token name that `grep` over the carriers would have found.
NOT Report a framework default as a project token unless the config extends it.

OUTPUT
L1 SYSTEM: PRESENT | PARTIAL | ABSENT -- primary carrier, plus `styleseed` when step 4 ran.
   Tokens -- group, path, values. Primitives -- name, path, variant mechanism.
   Conflicts -- only if non-empty: token, value A at path, value B at path.
CAP 250w plus the tables
