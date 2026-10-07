---
name: speckit-spec-modes
description: When working in specs/ or .specify/ — spec modes and SpecKit workflow assets.
globs: ["specs/**", ".specify/**"]
---

# Spec And SpecKit Workflow

- Follow the project's existing documentation convention. Use an acceptance note
  for understood local work; use a lightweight spec or the full Specify/SpecKit
  workflow when uncertainty, affected contracts, or recovery difficulty require it.
- Do not create `specs/` or `.specify/` solely for a small script or mechanical change.
  When adopting SpecKit, keep its specs in `specs/`. Preserve required project records.
- Choose one spec mode per project: no SpecKit, lightweight specs, or the full
  Specify/SpecKit workflow. Document a mode change; do not introduce a competing workflow.
- Keep `.specify/` workflow assets separate from durable project docs in
  `docs/`.

Doc-writing style rules (READMEs, docs, PR text) live in slopvac.
