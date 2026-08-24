# Roles, models, escalation

Route each role to the **cheapest capable model**; escalate up only on hard
cases. Agents render into the `task` tool schema. The mapping below is the
default starting point; pin `model: "@<role>"` from agent frontmatter.

| Role | Agent (default → alternatives) | Model / effort | Persistence | Escalation |
|---|---|---|---|---|
| **Orchestrator** | you (lead session) | your session model | whole run | delegate deep planning / disputes |
| **Researcher** | `Explore` → `general-purpose`, `researcher` | **cheap tier** low/med | ephemeral (reuse for follow-ups) | → mid tier when a single task is synthesis-heavy (see fan-out/fan-in below) |
| **Docs-guard** | `docs-guard` (`agent-quality-guards`) | **cheap tier** medium, read-only | ephemeral | → reviewer when policy or meaning is disputed |
| **Data-metrics-summarizer** | `data-metrics-summarizer` (`agent-quality-guards`) | **cheap tier** medium, read-only | ephemeral | → researcher when interpretation is required |
| **Lint-guard** | `lint-guard` (`agent-quality-guards`) | **cheap tier** high, read-only | ephemeral | → reviewer when rule intent is disputed |
| **Maintenance-metrics-reader** | `maintenance-metrics-reader` (`agent-quality-guards`) | **cheap tier** low, read-only | ephemeral | → researcher when a root cause is ambiguous |
| **Reviewer-mechanics** | `reviewer-mechanics` (`agent-quality-guards`) | **cheap tier** low, read-only | ephemeral | → reviewer on deeper correctness questions |
| **Architect** (default) | `architect` (bundled) | **mid tier** medium | per node, kept alive across fix rounds | → `architect-high` when a node fails on reasoning depth |
| **Architect** (deep) | `architect-high` (bundled) | **top tier** high | per node, kept alive across fix rounds | already the deep rung -- on a further block it raises `BLOCKED` |
| **Reviewer** | `orchestration-reviewer` | **mid tier** medium, read-only | kept alive per node (re-reviews deltas) | → top tier for complex or security-critical diffs |
| **Advisor** | `orchestration-advisor` | **top tier** high, read-only | ephemeral, **spawned by the orchestrator** | already top tier |
| **Shepherd** | `shepherd` (bundled) | **mid tier** medium | **persistent** | → top tier only if merge reasoning is genuinely gnarly |
| **Scribe** | `scribe` (bundled) | **cheap tier** low, read-only | ephemeral | escalate to mid if issue interpretation is ambiguous |
| **Tiebreaker** | `general-purpose` (fresh) | **top tier** high, read-only | ephemeral, gated | → xhigh only if genuinely complex |

Workflow roles ship with this plugin (architect, orchestration-reviewer, orchestration-advisor, shepherd, scribe); quality-guard roles (docs-guard, lint-guard, data-metrics-summarizer, maintenance-metrics-reader, reviewer-mechanics) come from the `agent-quality-guards` dependency; the remaining routes are built-in agents (`Explore`,
`general-purpose`) present everywhere. Route to an agent only when the catalog
you are running against actually ships it; `code-reviewer`, `pr-reviewer`,
`adversarial-challenger` and `debugger` are not part of this package.

"Persistent" means the role is always available for the run, not that it is one
never-restarted process -- recycle the Shepherd to shed context (see
`references/lifecycle.md`). The orchestrator never executes work directly; see
SKILL.md Core rules.

## Capabilities & access -- what each role may do

| Role | Writes | Spawns | Runs in | Notes |
|---|---|---|---|---|
| Orchestrator | no code | **everything; sole dismisser** | lead session | prepares every role checkout with Worktrunk; coordination + deterministic scripts only |
| Docs-guard | nothing (read-only) | nothing | own Worktrunk checkout when using tools | flags low-signal doc issues before merge review |
| Data-metrics-summarizer | nothing (read-only) | nothing | artifact-only, or own Worktrunk checkout when reading the repo | compacts logs/telemetry into bounded, prompt-driven summaries |
| Lint-guard | nothing (read-only) | nothing | own Worktrunk checkout when using tools | triages lint artifacts and classifies likely false positives |
| Maintenance-metrics-reader | nothing (read-only) | nothing | own Worktrunk checkout when reading repo metadata or trees | emits `MAINTENANCE SNAPSHOT <scope> status=PASS\|WARN\|FAIL` with top signals and evidence |
| Reviewer-mechanics | nothing (read-only) | nothing | own Worktrunk checkout | emits `MECH-REVIEW <scope> verdict=PASS\|CHANGES` with deterministic `file:line` findings |
| Architect | its `scope` only | throwaway children | checkout named by the bead's `metadata.worktree` | children run in that same checkout but never claim, commit, push, or manage worktrees; on block → `BLOCKED kind:design\|debug` |
| Reviewer | nothing (read-only) | nothing | separate Worktrunk checkout created from writer branch | logs `review` verdict as audit record + bead comment |
| Advisor | nothing (read-only) | nothing | separate Worktrunk checkout when using tools | one `ADVICE`, then exits |
| Shepherd | integration branch / merges | nothing | dedicated integration Worktrunk checkout | merge + push authority only; never mutates content trees |
| Scribe | nothing (read-only) | nothing | reads beads db + artifacts | never in the write path |
| Researcher | nothing (read-only) | nothing | separate Worktrunk checkout when using repository tools | returns a terse findings digest |
| Tiebreaker | nothing (read-only) | nothing | separate Worktrunk checkout when using repository tools | binding `ADVICE`, logged |

## Architect layer is optional

The architect layer is a dispatch depth the orchestrator chooses per run. One
mechanism either way -- same beads, same briefs, same claim rules. The only
difference is who creates the child beads.

| Mode | Shape | Use when |
|---|---|---|
| **Direct dispatch** | orchestrator → workers | the work list is enumerable without reading domain code -- mechanical migrations, per-file fixes, review fan-out |
| **Architect dispatch** | orchestrator → architect → workers | the decomposition itself needs domain expertise, or the work is discovered as it goes |

Choose one mode per run. Neither adds a second dispatch protocol to maintain.

## Specialist dispatch

| Input | Route | Boundary |
|---|---|---|
| Documentation-only node or documentation lint report | `docs-guard` | syntax, links, structure, and reported documentation findings only |
| Existing lint report with many or stale findings | `lint-guard` | validate and normalize the report; never replace the project linter |
| Large scoped log, metric, CSV, JSON, or JSONL artifact | `data-metrics-summarizer` | compact the supplied evidence; never diagnose or recommend |
| Repository hygiene scan (stale branches, worktrees, locks) | `maintenance-metrics-reader` | report signals with evidence; never delete or repair |
| Scoped diff smoke-check before review handoff | `reviewer-mechanics` | mechanical findings only; never judge design or merge strategy |

These specialists preprocess bounded evidence. A semantic correctness decision
still belongs to `orchestration-reviewer`, a researcher, or `orchestration-advisor`.

### Which architect rung

Two rungs. The gap is a model step AND an effort step at once on both runtimes,
so the deep rung is not merely the default one thinking harder. The pins
themselves live in `agent-models.yml` and the agent frontmatter.

| Node needs | Route |
|---|---|
| Execution, decomposition, cross-file design, or delegation to children | `architect` |
| A retry after the default rung failed **on reasoning depth** | `architect-high` |

Default to `architect`. `-high` is escalation-only -- if you cannot name
the attempt that failed and say the failure was reasoning depth rather than
missing context, a tooling block, or bad scope, it is not the answer.

**Only the orchestrator spawns or dismisses claim-holders, orchestration-reviewer, and
orchestration-advisor.** An architect may nest bounded throwaway implementation children in
its own checkout, spawning them directly with the files they own stated in the
brief. A child sharing the parent's checkout never claims, commits, pushes, or
manages worktrees; the architect collects each child before reporting. No other
worker nests (SKILL.md core rule 5).

Prefer `Explore` for read-only search, call-path tracing, and fan-out. Use
`general-purpose` only when no narrower agent covers the work. Never spawn a
claim-holder role as a child: `researcher`, `orchestration-reviewer`, `orchestration-advisor`, `scribe` and
`shepherd` claim their own beads and are dispatched by the orchestrator.

Route a **read-only** node to Researcher rather than Architect in the
first place. The delegating role earns its nesting on volume-heavy execution; on
pure analysis the reading IS the reasoning, so children only add a hop and
re-read context the parent already holds.

## Researcher fan-out / fan-in

The orchestrator owns research decomposition and never reads raw sources itself.

- **Narrow question:** one Researcher (`Explore`, cheap tier), returns a terse digest.
- **Broad research -- fan-out then fan-in:**
  1. **Fan-out:** the orchestrator spawns several cheap **cheap-tier gatherers** in
     parallel, each scoped to one source, slice, or sub-question. Each returns a
     terse findings digest (facts + `refs`, not prose) -- nothing raw.
  2. **Fan-in:** the orchestrator hands all digests to **one mid-tier synthesizer**
     that dedupes, resolves conflicts, and returns a single synthesis with
     citations.
  3. The orchestrator keeps only the synthesis; gatherers and synthesizer are
     dismissed. Escalate the synthesizer a tier only if the material is
     genuinely contradictory or high-stakes.

Gatherers are read-only and spawn nothing; the fan-out width is the orchestrator's
call (bound it to the sources that matter -- log what was skipped).

## Escalation ladder

1. `BLOCKED kind:design` → `orchestration-advisor` (top tier, one-shot).
2. `BLOCKED kind:debug` (red verify, stuck diagnosing) → `general-purpose`
   read-only; it investigates independently and returns findings as `ADVICE`
   via the orchestrator.
3. Anything outside the brief, or a decision needing product intent → bubble
   `ASK` to the human.

Never silently upgrade a whole role to the top tier to paper over a one-off hard case;
escalate the specific instance.
