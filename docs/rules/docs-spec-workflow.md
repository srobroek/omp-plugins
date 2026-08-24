---
name: docs-spec-workflow
description: When working in specs/ or .specify/ — spec modes and SpecKit workflow assets.
globs: ["specs/**", ".specify/**"]
---

# Spec And SpecKit Workflow

Use `specs/` in every project.

Choose one spec mode:

- no SpecKit, with `specs/` only
- lightweight specs
- full Specify or SpecKit workflow

Do not mix modes without documenting why. Full SpecKit projects should keep
`.specify/` workflow assets separate from durable project docs in `docs/`.

Doc-writing style rules (READMEs, docs, PR text) live in the slopvac package
(`srobroek/slopvac`).
