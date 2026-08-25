---
name: speckit-setup
description: Bootstrap SpecKit end-to-end -- scaffold, extensions, workflows, gates. Use when setting up SpecKit, when /speckit.* commands are missing, or to initialize/enable SpecKit.
---

# SpecKit Setup

Idempotent one-time bootstrap. Prefer the native `speckit_setup` tool over
re-implementing the steps by hand.

Requires `specify-cli` >= 0.12.0 (`uv tool install specify-cli`).

## When to use

- A repo needs SpecKit but `.specify/` doesn't exist yet.
- `/speckit.*` slash commands are missing or extensions are not installed.
- The user asks to "set up / initialize / enable SpecKit".

## What it does

Call `speckit_setup` (or walk the same steps if the tool is unavailable):

1. `specify init --here --force --integration <codex|claude> --script sh`
2. Register the community catalog (`catalog.community.json`).
3. Install + enable the required extensions: `agent-context`, `agent-assign`,
   `bugfix`, `cleanup`, `critique`, `fix-findings`, `iterate`, `qa`, `refine`,
   `retro`, `review`, `roadmap`, `security-review`, `tinyspec`, plus
   `status-report` from `latest-release:Open-Agent-Tools/spec-kit-status`.
   Custom-source installs are best-effort.
4. `bd init --skip-hooks` if no workspace; copy every formula from
   `skill://speckit-setup` sibling plugin `formulas/` into `.beads/formulas/`.
   Formulas: `speckit-feature`, `speckit-lean`, `speckit-basic`,
   `mol-speckit-iterate`, `mol-speckit-fix-findings`, `mol-speckit-bugfix`,
   `mol-speckit-refine`. Keep the `mol-` prefix.
5. Append `specs/**/spec-status.md` to `.gitignore`.

`force=true` re-scaffolds even if `.specify/` exists. `skipSpecify=true`
installs only formulas + gitignore.

Then start with `/speckit.specify`. Workflow order is the poured molecule;
`bd mol current <root>` is current position.

`specify workflow` YAML is not installed. Do not invent extension ids.
Do not add speckit-gate or speckit-dag-hooks.

`build-formula` (authoring a new formula) lives in the beads plugin.
