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
- vendor guideline conformance -> `platform-conformance`

GATES
ASK Creating a token set after an ABSENT verdict. The user approves a new system; the audit never starts one.

## Workflow

1. Route to the upstream skill for the task, in this order. -> the chosen route is named
   in the report header.
   - `ss-tokens` for token and design-system work. The winner.
   - `ui-ux-pro-max` for product-wide visual direction, invoked with `--design-system`.
   - `ss-score` only when validating a StyleSeed artifact contract and file-and-line
     evidence is needed; it emits `deterministic.json` with detector ids and fix text.
2. Check the routed name is in your available skills BEFORE loading it. Reading a
   `skill://` path that does not exist throws `Unknown skill`. -> present: LOAD and follow.
   Absent: STOP, emit the install command from
   `skill://design-system-audit/references/upstream.md`, and run it. Do not substitute
   your own inventory for the upstream's.
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
MUST Resolve the real installed plugin directory before running `ui-ux-pro-max`'s
  `scripts/search.py`. `${CLAUDE_PLUGIN_ROOT}` is substituted only into MCP `command`,
  `cwd`, `args`, and `env`, never into skill body text or the shell, so the literal
  string reaches the shell unexpanded and the lookup fails.
DEFAULT Label a value `observed` when read from a carrier and `inferred` when derived
  from usage. Later phases treat the two differently.
NOT Propose a token name that `grep` over the carriers would have found.
NOT Report a framework default as a project token unless the config extends it.

OUTPUT
L1 SYSTEM: PRESENT | PARTIAL | ABSENT -- route used, plus the primary carrier.
   Tokens -- group, path, values. Primitives -- name, path, variant mechanism.
   Conflicts -- only if non-empty: token, value A at path, value B at path.
CAP 250w plus the tables
