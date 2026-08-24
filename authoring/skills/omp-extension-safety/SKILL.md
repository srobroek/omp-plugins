---
name: omp-extension-safety
description: Use when writing or reviewing an OMP extension module (tool_call gates, tools, event handlers).
---

# OMP Extension Safety

TRIGGER
+ writing or reviewing `pi.on("tool_call"|…)` / `registerTool` / event handlers
+ an extension that took the session down (TypeError, uncaughtException)
- choosing TTSR vs gate vs tool → `skill://omp-surface-choice`
- marketplace/link install wiring only → `skill://omp-plugin-authoring`

## Fail-closed vs advisory

MUST A throwing `tool_call` handler **blocks the tool** (`omp://skills/authoring-extensions.md`, `omp://extensions.md`).
MUST A handler on every bash call that throws is a **total bash outage**. Session incident: `.has()` on a plain object → TypeError on the first bash command.
MUST Wrap all fallible logic. Default allow on uncertainty.
NOT Treat `tool_result` as fail-closed — it is not. Prefer it for advisory injection.

## Timers

MUST Use `ctx.setInterval` / `ctx.setTimeout`. They contain throws and clear on `session_shutdown`.
NOT Raw `setInterval`/`setTimeout` callbacks that throw crash the **whole session** (`uncaughtException`).

## Subprocess

MUST Argv arrays, never shell strings.
MUST Explicit timeout.
MUST Cache expensive results.
MUST Prefilter first — never spawn on unrelated calls.

## Lookups

MUST Use `Set`/`Map` for token lookups.
NOT A plain object — `obj["constructor"]` is truthy (prototype-chain hazard). Same class of bug as the `.has()` outage.

## Load vs act

MUST Register only during module load.
NOT Call runtime actions (`pi.sendMessage`) during load — throws `ExtensionRuntimeNotInitializedError` (`omp://extensions.md`).

## Ship check

1. Parse: `bun build --target=bun <file> --outdir /tmp/x --external '@oh-my-pi/*'`
2. Smoke in a real session: `omp -p`

## Manifest

MUST `package.json` `omp.extensions` is how marketplace/linked installs load modules (`omp://marketplace.md`, `omp://skills/authoring-extensions.md`).
MUST The `omp` key is also the recognition marker for the whole plugin (empty `{}` still counts).
