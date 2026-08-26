---
name: design-overview
description: Reports what the design package provides and what is missing. Triggers on what design skills are available or which design agent should I use.
---

# Design Overview

Report what the `design` package gives this session. Do not start design work.

TRIGGER
+ "what design skills / agents do I have"
+ "which design skill handles <job>"
+ before a first design task in an unfamiliar repository
- already know the route -> load that skill directly
- want tool invocations -> `skill://ui-review/references/tools.md`

GATES
1. Named one skill, agent, rule, or formula? Report only that, then STOP.

## Workflow

1. Phases. Name the skill routed at each of GROUND, SPECIFY, BUILD, VERIFY, CRITIQUE,
   RECONCILE, plus the three gates: INTENT after GROUND, SYSTEM when a system audit returns
   ABSENT or PARTIAL, ACCEPT after RECONCILE. -> six phases, each with one named skill.
2. Agents. `ui-ux-specialist` leads and spawns; `design-critic` and `a11y-auditor` review
   read-only. -> state which are spawnable for you now, not which the package ships.
3. Skills. One row each: name, phase, WRAPPER or LOCAL or VENDORED, and for a wrapper the
   upstream plus whether it is in your available skills. Read each `SKILL.md` frontmatter
   for its description. -> every row's availability comes from this session.
4. Rules. Each rule and the one thing it governs. -> state that a subagent loads no
   steering, so a reviewer sees only what its own body inlines.
5. Formulas. Each formula, its tier or job, its `--var` names, and whether it is poured
   directly or bonded onto the step that found the work.
6. Tools. Point at `rule://design-tool-ladder` for routing and
   `skill://ui-review/references/tools.md` for invocations. Never restate either table.
   -> name any MCP server this package declares that did not connect this session.
7. Gaps, last and always. Absent upstream skills, MCP servers that did not connect, and CLI
   tools whose account or download step has not run, each with the command that fixes it.

## Rules

MUST Report availability from what you can see in this session. An upstream you cannot
  confirm is reported as unknown, never as present.
MUST Name the install command for every absent upstream. An absent upstream is the one gap a
  user can close immediately.
NOT Start the work the overview describes. The user asked what exists.
NOT Restate the tool ladder or the command reference. Both drift the moment they are copied.
DEFAULT Order by phase rather than alphabetically, because the phase is how the work routes.

OUTPUT
L1 one line: how many agents and skills are usable, and how many upstreams are missing.
CAP 200w clean, 320w when gaps need install commands.
