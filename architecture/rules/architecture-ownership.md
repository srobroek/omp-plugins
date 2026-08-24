---
name: architecture-ownership
description: When placing libs, owner-local data/contracts/prompts, schemas, generated clients, or product agents.
globs: ["libs/**", "services/**", "schemas/**", "packages/**"]
---

Keep `libs/` organized by architectural role: `domain`, `application`,
`adapters`, `config`, `testing`, `ui`, and `types`.

`libs/domain` is pure domain logic. It must not import network, database,
filesystem, framework, or cloud SDK dependencies.

Use owner-local folders for owned assets:

- service data under `services/*/data`
- service contracts under `services/*/contracts`
- prompts and evals under the owning service or library

Use root `schemas/` only for shared or public contracts. Generated clients live
with consumers or in independently versioned packages.

AI/product agents are owned by services or libraries. Do not create a root
`agents/` directory for product code.
