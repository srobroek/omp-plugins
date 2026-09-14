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

MUST Identify independent slices before substantive work. MUST Dispatch all independent slices in one parallel `task` batch. When agents can own slices without conflicting edits, MUST use multiple workers. NEVER Serialize independent slices.

DEFAULT Use `scout` for read-only repository discovery and analysis. DEFAULT Use `operator` for explicit mechanical commands. DEFAULT Use the default task agent for implementation.

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
