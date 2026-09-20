---
name: watchdog-files
description: Create, audit, and update WATCHDOG.yml and WATCHDOG.md advisor files for a project. Triggers on add a watchdog, configure the advisor, tune advisor noise.
---

# Watchdog Files

TRIGGER
+ "add a watchdog to this repo" / "configure the advisor here"
+ "the advisor is noisy / wrong / too late" for a specific project
+ repo has a recurring, mechanically checkable risk no reviewer catches
- machine-wide advisor policy (model role, immuneTurns, enablement) → `omp config`
  and the user-level files under the active agent dir
- reviewing a diff or PR now → `code-review`, `reviewer` agent

GATES
ASK Which single risk class must this project's advisor catch that the user-level
    contract does not already cover?

## Workflow

1. Read the user-level contract first: `<agent dir>/WATCHDOG.md` and
   `WATCHDOG.yml`. A project file that repeats it is pure cost.
2. Run `scripts/watchdog-audit.sh <repo>` → discovery order, duplicate advisor
   slugs, per-file line/word counts, and roster/model/tool conflicts.
3. Write `<repo>/.omp/WATCHDOG.md` for repo-specific risk only: name the artifact
   that proves each finding and the silence cases. Keep it under 40 lines.
4. Add a roster entry only when the risk needs its own model or tool scope; put it
   in `<repo>/.omp/WATCHDOG.yml` with an `instructions:` block under 120 words.
   Reuse the user-level advisor name to replace it; use a new name to add a loop.
5. Verify live in a scratch copy: `scripts/watchdog-probe.sh <repo> <scenario-prompt>`
   → per-review seconds, notes emitted, and whether each note cites an artifact.
6. LOAD references/failure-modes.md when tuning an advisor that already fires
   wrongly, and references/mechanics.md when discovery or prompt order is unclear.

## Rules

MUST Keep one advisor unless a second has a disjoint artifact class, its own model,
  or its own tool scope. Every extra entry is another model loop, another token
  stream, and another immunity window competing for the same turn boundary.
MUST Bind every trigger to a quotable artifact: `path:line`, a command plus its
  output, a diff hunk, or a tool result. A trigger with no artifact produces the
  stale and hallucinated notes that dominate advisor defects.
MUST State the silence cases next to each trigger: already handled, user
  authorized, stale evidence, capability denial, duplicate.
MUST Keep project guidance additive. It never lowers the user-level evidence gate
  and never restates it.
DEFAULT Grant no `tools:`; the default `read`/`grep`/`glob` set is the review scope.
  Mutating grants run under normal approval but make the reviewer an actor.
DEFAULT Pin `model:` only to change speed or cost class, and pin the fastest model
  that still cites artifacts; a non-blocker note is delivered turns after it is
  written, so review latency compounds with delivery lag.
NOT Progressive disclosure. An advisor session is persistent and reads every
  referenced file eventually, at one extra model call and a full prefill each time.
  Inline the contract instead of indexing playbooks.
NOT Severity inflation. `blocker` requires a quotable command or diff that
  destroys work; a project file that makes everything a blocker starves the
  `concern` channel behind the immunity window.

OUTPUT
L1 `<repo>: <N> advisor(s), <M> project file(s)` + the one risk each covers
   `conflicts` — duplicate slugs, model divergence, restated user-level text
   `probe` — per-review seconds, notes per review, artifact-citation rate
CAP 120w clean · 250w with findings
