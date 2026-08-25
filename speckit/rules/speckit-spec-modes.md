---
name: speckit-spec-modes
description: When working in specs/ or .specify/ — spec modes and SpecKit workflow assets.
globs: ["specs/**", ".specify/**"]
---

# Spec And SpecKit Workflow

- Use `specs/` in every project, regardless of mode.
- Choose one spec mode per project: no SpecKit (`specs/` only), lightweight
  specs, or the full Specify/SpecKit workflow. Do not mix modes without
  documenting why.
- Keep `.specify/` workflow assets separate from durable project docs in
  `docs/`.

Doc-writing style rules (READMEs, docs, PR text) live in slopvac.
