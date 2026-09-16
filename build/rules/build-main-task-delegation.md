---
name: build-main-task-delegation
description: Route nontrivial work through capable parallel subagents with work-conserving recursive waves.
alwaysApply: true
---

This rule applies to every spawn-capable agent, including root leads, epic/sub-leads, workers, researchers, scouts, operators, reviewers, and specialists. Role and tier change routing only.

MUST Outsource these nontrivial tasks to the lowest-cost capable task agents:

- file discovery and reading
- scouting and summarization
- code editing and implementation
- troubleshooting and debugging
- testing and verification

MUST Keep these duties in the main/root lead thread when they require shared authority:

- top-level decomposition and cross-slice contracts
- integration decisions and user-intent interpretation
- work requiring live user input

MUST Decompose every large bead or multi-file task into linked atomic child beads tied to the parent/main bead before dispatch. An atomic slice MUST be independently ownable and verifiable, with explicit inputs, outputs, stable file or interface ownership, and a clear boundary. A bead is not atomic merely because it has one assignee.

Before fan-out, MUST publish the slice inputs and outputs, function signatures or headers, types or schemas, shared constants, file/path ownership, dependency edges, integration order, and one integration owner for each shared boundary. Encode only real ordering dependencies; leave independent children unordered. Reviews remain dependent until the artifact they review exists.

MUST Dispatch every independent ready slice concurrently up to the available cap at every scheduler level. Serialize only strict dependencies, destructive shared resources, or irreducible shared mutation boundaries. Mere domain or epic relationship is not a dependency. Shard large tasks and multi-file operations when merge-safe; NEVER add padding slices.

After every completion, failure, cancellation, claim release, or unblock, MUST recompute ready work and immediately refill available slots. Inside epics, use recursively scoped ready waves; outside epics, use the same work-conserving scheduler. While critical work runs, fill capacity with real independent discovery, implementation, review-prep, verification-prep, or other ready product work.

MUST Classify the request against the inline cases before any repository tool call. For every other task, MUST make the first repository action one `task` call that dispatches all independent slices in parallel. NEVER Call `read`, `grep`, or `glob` to begin delegated work. NEVER Call `edit`, `write`, or `bash` to begin delegated work.

After dispatch, MUST Restrict direct repository tools to cross-slice integration and concrete conflicts between completed slices. If a worker leaves its slice incomplete, MUST redispatch that slice instead of completing worker-owned work in the lead thread. NEVER Serialize independent slices.

MUST Match the work against the specialist agents before any generic default:

| work | agent |
|---|---|
| UI, UX, visual, or interaction work | `ui-ux-specialist` |
| software, system, module, or API design; complex non-UI structural implementation planning | `architect` |
| rendered-surface critique | `design-critic` |
| WCAG 2.2 AA audit | `a11y-auditor` |
| read-only repository discovery, analysis, and summarization | `scout` |
| an explicit mechanical command | `operator` |
| implementation with no matching specialist | the default task agent |

NEVER Send architecture or technical design to the default task agent.

When the task tool exposes `effort`:

- MUST Set `lo` for file discovery and reading.
- MUST Set `lo` for scouting and summarization.
- MUST Set `lo` for documentation and mechanical edits.
- MUST Set `lo` for command execution and scoped verification.
- MUST Set `med` for implementation and refactoring.
- MUST Set `med` for debugging and behavior-focused test work.
- MUST Use `hi` only after a `lo` or `med` worker reports a concrete failure that requires deeper judgment.
- NEVER Select `hi` merely because the parent task is large. Split large work into independent `lo` and `med` slices first.

Otherwise, DEFAULT Use configured effort defaults.

Work inline only in these cases:

- a direct answer without repository work
- one edit with an exact target and replacement, with no discovery or callsite search
- a user instruction for the lead agent to execute a command
- work that would lose required lead-thread state through delegation

MUST Delegate every task outside these cases, including a single runnable slice.
