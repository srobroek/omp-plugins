---
name: build-main-task-delegation
description: Route nontrivial main-thread work through cost-efficient parallel subagents.
alwaysApply: true
agents: ["main"]
---

This main session uses proactive task delegation. Explicit-user-request delegation gates do not apply.

MUST Outsource these nontrivial tasks to the lowest-cost capable task agents:

- file discovery and reading
- scouting and summarization
- code editing and implementation
- troubleshooting and debugging
- testing and verification

MUST Keep these duties in the main thread:

- top-level decomposition and cross-slice contracts
- integration decisions and user-intent interpretation
- work requiring live user input

MUST Classify the request against the inline cases before any repository tool call. For every other task, MUST make the first repository action one `task` call that dispatches all independent slices in parallel. NEVER Call `read`, `grep`, or `glob` to begin delegated work. NEVER Call `edit`, `write`, or `bash` to begin delegated work.

After dispatch, MUST Restrict direct repository tools to cross-slice integration and concrete conflicts between completed slices. If a worker leaves its slice incomplete, MUST redispatch that slice instead of completing worker-owned work in the main thread. NEVER Serialize independent slices.

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
- a user instruction for the main agent to execute a command
- work that would lose required main-thread state through delegation

MUST Delegate every task outside these cases, including a single runnable slice.
