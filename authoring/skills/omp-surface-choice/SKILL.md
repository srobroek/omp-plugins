---
name: omp-surface-choice
description: Use when deciding whether guidance becomes a TTSR rule, a tool_call gate, a registered tool, a slash command, a skill, or stays prose.
---

# OMP Surface Choice

TRIGGER
+ "should this be a rule / tool / skill / command?"
+ prose that lists deterministic steps
+ a safety check that must fire before bash/edit
- implementing the extension module itself → `skill://omp-extension-safety`
- packaging/installing the plugin → `skill://omp-plugin-authoring`

## Two axes

| | Pattern-detectable (text / tool args) | Needs evidence (files, process) | Needs execution (typed work) |
|---|---|---|---|
| **Invariant** (must hold) | TTSR (`interruptMode: always`) | `tool_call` gate (throw/block) | `registerTool` + fail-closed handler |
| **Advisory** | TTSR (default inject) or skill prose | `tool_result` inject, or skill | `registerTool` returning findings |

`registerCommand`: user-invoked only. The model cannot call it.

Skill: judgment, interviews, multi-step reasoning a schema cannot carry.

## TTSR

- Regex `condition` or `astCondition` on streamed text / tool args.
- CANNOT shell out or read files.
- `interruptMode: always` aborts **before** the tool runs.
- Default injects a system-reminder **after**.
- `ttsr.repeatMode` governs re-arming.
- Cheapest surface: zero tokens until triggered.
- Defense-in-depth, **never** a security boundary.

See `omp://rulebook-matching-pipeline.md`.

## tool_call gate

- CAN read files and spawn subprocesses.
- THROWING BLOCKS THE TOOL (fail-closed). Wrap everything; allow on uncertainty.
- Cheap in-memory prefilter (path prefix, tool name) **before** any subprocess.
- Cache expensive results. Session-verified: `chezmoi managed` is 222 ms once, then O(1) set lookups.

## registerTool

Use when the model must **remember** to do the work, or prose would orchestrate deterministic steps.

MUST Move deterministic work out of the skill body into a typed tool.
DEFAULT The tool MAY wrap an existing script via subprocess so logic and tests survive.
MUST The skill keeps only judgment: when, why, what to do with results.

See `omp://skills/authoring-extensions.md` (registerTool).

## registerCommand

User types `/name`. Model cannot invoke it. Session control lives here (`waitForIdle`, `newSession`, …).

## Skill

Judgment workflows. Interviews. Multi-step reasoning. Schema cannot carry it.

## Hard bash boundary

`bash.patterns` deny in config is the only hard pre-execution bash boundary that holds in **every** approval mode. TTSR and gates layer above it.
