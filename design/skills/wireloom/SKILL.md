---
name: wireloom
description: Authors a wireframe mockup as inline SVG from a fenced wireloom block. Triggers on mock up a dialog or draw a wireframe.
---

<!--
Vendored from StardockCorp/Wireloom, path .claude/skills/wireloom.md, copied 2026-08-26.
Licensed under the MIT License, Copyright (c) 2026 Brad Wardell. The full licence text is
in the LICENSE file beside this one.

THIS FILE HAS BEEN MODIFIED from the original. Changes:
  1. The upstream instruction to load the grammar from a repository-relative path was
     replaced with the canonical raw URL, because that file is not vendored here. The
     grammar is 44,558 bytes and changes with the tool, so citing it by URL keeps it
     current rather than shipping a copy that goes stale silently.
  2. Added the install line for the renderer, and the note on why this skill is vendored
     rather than advertised as a catalog entry.
  3. Rewrote the frontmatter description to this repository's authoring contract: under
     25 words, third person, no em-dash.
The process steps, the trigger list, the when-not-to-use table, and the subagent note are
upstream's and are unchanged in substance.
-->

# Wireloom

Author a UI wireframe mockup in the Wireloom DSL, a small indentation-based text language
that renders to inline SVG.

TRIGGER
+ "mock up a dialog", "draw a wireframe for", "sketch the layout of"
+ "show me how this feature would look", "diagram the toolbar"
+ any UI-shape question about a surface that is not already running
- a flowchart, sequence, class, ER, or state diagram -> a `mermaid` fenced block
- an interactive prototype -> write the real component, or `design-prototype`
- a graph of data -> a real chart library

## Workflow

1. Read the full grammar before authoring. The primitive tables, attribute rules, and
   examples live at
   `https://raw.githubusercontent.com/StardockCorp/Wireloom/main/AGENTS.md`. -> the widget
   set for the current version is in context.
2. Emit a single fenced `wireloom` code block. -> no prose description of the layout, no
   ASCII art, and no `mermaid` block standing in for a UI layout.
3. Start the source with `window:` or `window "Title":` as the single root. -> annotations
   are siblings of `window`, never children of it.
4. Pick the right primitive per control: `toggle` for a settings toggle rather than `kv`,
   `tree` and `node` for a file tree rather than nested `list` and `item`. -> each control
   uses the primitive that represents it, so the render reads as the real thing.
5. Render it when the project has the renderer: `npm install wireloom`. The package ships a
   library and no bin, so a build step or a script calls it. -> inline SVG, self-contained,
   and diffable in git because the source stays text.

## Rules

MUST Lock indentation to 2 or 4 spaces for the whole file. Tabs are a parse error.
MUST Read the grammar at the URL above rather than recalling primitive names. The widget
  set is versioned and a remembered name is a stale name.
DEFAULT One `window` root per block. A second screen is a second block.
NOT Describe the layout in prose instead of emitting the block. Agents default to prose or
  ASCII art unless told otherwise, which is the failure this skill exists to prevent.
NOT Use this for a diagram that is not a UI layout.

## Delegating to a subagent

A subagent needs the instruction explicitly, because it shares none of this context:

> Emit a fenced `wireloom` code block following the Wireloom grammar at
> `https://raw.githubusercontent.com/StardockCorp/Wireloom/main/AGENTS.md`. Do not
> describe the layout in prose.

## Why this is vendored

The upstream skill is a bare markdown file at `.claude/skills/wireloom.md`. OMP discovers
skills at `<plugin-root>/skills/<name>/SKILL.md`, so a catalog entry pointing at that
repository installs cleanly and contributes no skill at all. That was verified
empirically, not inferred. The file is MIT with a LICENSE file, so vendoring it is
permitted, and vendoring is the only way to make it reachable.

OUTPUT
L1 WIREFRAME: one fenced `wireloom` block.
   Open -- what the wireframe does not settle, since a wireframe fixes layout and flow
   rather than final visual detail.
CAP 60w plus the block
