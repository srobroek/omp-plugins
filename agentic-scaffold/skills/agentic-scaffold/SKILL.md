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

| Phase | Load | Lead action and exact command |
|---|---|---|
| Preflight | `references/guidebook.md` | Call `scaffold` with `command: "preflight"`, `args: ["--profile", P]`. Read `root`, `hard`, `soft`, and `tools`. |
| Interview | `references/interview.md` | Call `scaffold` with `command: "interview"`, `args: ["questions", "--profile", P]`. Read `root` and `questions`; ask every `required: true` question with `ask`. |
| Answers | `references/interview.md` | Call `scaffold` with `command: "answers"`, `args: ["write", "--profile", P, "--set", "k=v", "--defaults-for", "…"]`. Read `root`, `profile`, `layers`, `defaults_for`, and `vars`. |
| Plan approval | `references/guidebook.md` | Call `scaffold` with `command: "apply"`, `args: ["--dry-run"]`. Read `root`, `ok`, and `stages`; show the plan and wait for explicit approval. |
| Apply | `references/guidebook.md` | Delegate a `task` to `scaffolder`; it calls `preflight`, `apply`, `doctor`, and `finish`. Read each JSON result and stop on non-zero. |
| Handoff | `references/verify.md` | Present the successful `finish` JSON and its `commitCommand`; the agent never commits. |

## Rules

MUST Run the interview command before answers and use `ask` for every required question; never assume a default for a required question.
MUST Show `apply --dry-run` and wait for the human's approval before delegating execution.
MUST Delegate execution to `scaffolder` with `task`; the lead does not run installation or write commands.
MUST Use the `scaffold` tool for every deterministic step and pass no user-controlled root, cwd, state, answers, output, or `-C` argument.
MUST Keep all writes under the session project root; the active run boundary blocks direct edits and unsafe shell commands.
MUST Stop and report CLI JSON verbatim on non-zero, including exits 2 (drift), 3 (needs input), 5 (conflict), and 6 (boundary).
MUST Present `finish`'s commit command only after doctor and finish succeed; never commit as the agent.
NOT Run `chezmoi apply`, mutate global configuration, install user-scope plugins, invent tests, or work around a blocked command.
NOT Continue after an advisor or watchdog says scope is unsafe; report the message and stop.
