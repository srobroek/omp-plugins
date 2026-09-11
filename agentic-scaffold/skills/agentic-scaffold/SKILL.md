---
name: agentic-scaffold
description: Use when scaffolding or retrofitting a repository with deterministic project-local tools, layers, hooks, plugins, and agent instructions.
---

# Agentic scaffold

TRIGGER
+ scaffold a repository or agentic-only project
+ retrofit project-local instructions, hooks, context, or OMP plugins
+ apply or diagnose an existing scaffold run
- implement product code or choose a framework → use the project and toolchain skills
- change the global OMP plugin set → use the OMP configuration skill

## Workflow

1. Run `scaffold start --root R --profile P`. Read the findings and the `ask` payload. Continue only when the payload offers `Continue to the interview`.
2. Run `scaffold interview --root R --profile P`. Pass each answer in `--answers-so-far`. Repeat until `complete` is true.
3. Run `scaffold plan --root R --answers JSON`. Read `.omp/scaffold-plan.md` and present the returned `ask` payload.
4. Run `scaffold run --root R` after the human selects `Apply`. Read the doctor summary and `READY_FOR_COMMIT` handoff.
5. Run `scaffold finish --root R` after the commit. Present its final JSON.

## Rules

MUST Use the `ask` payload from each verb. Do not recreate questions or findings.
MUST Pass the complete answer object to `plan`. Do not hand-edit `.omp/scaffold-answers.toml`.
MUST Run `run` only after the human selects `Apply` in the plan ask.
MUST Run `finish` only after the human commits the scaffold output.
MUST Use the `scaffold` tool for every deterministic step and pass no user-controlled root, cwd, state, answers, output, or `-C` argument.
MUST Keep all writes under the session project root. The active run boundary blocks direct edits and unsafe shell commands.
MUST Stop and report CLI JSON verbatim on non-zero, including exits 2 (drift), 3 (needs input), 5 (conflict), and 6 (boundary).
NOT Run `chezmoi apply`, mutate global configuration, install user-scope plugins, invent tests, or work around a blocked command.
NOT Continue after an advisor or watchdog says scope is unsafe. Report the message and stop.
