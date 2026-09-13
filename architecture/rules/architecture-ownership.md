---
name: architecture-ownership
description: Opinionated repository ownership layout for repos adopting it; load when placing libs, owner-local assets, schemas, generated clients, UI primitives, or product agents.
---

Keep `libs/` organized by architectural role: `domain`, `application`,
`adapters`, `config`, `testing`, `ui`, and `types`.

`libs/domain` is pure domain logic. It must not import network, database,
filesystem, framework, or cloud SDK dependencies.

Keep components local to an app. Move shared primitives and design-system code
to `libs/ui` only after two app surfaces actually reuse them. Shared UI code
should be more stable than app-local components: use typed props, documented
variants, and reusable accessibility behavior.

Use owner-local folders for owned assets:

- service data under `services/*/data`
- service contracts under `services/*/contracts`
- prompts and evals under the owning service or library

Use root `schemas/` only for shared or public contracts. Generated clients live
with consumers or in independently versioned packages.

AI/product agents are owned by services or libraries. Do not create a root
`agents/` directory for product code.

## Data assets

Use this for data ownership, database assets, migrations, queries, seeds,
fixtures, datasets, pipelines, notebooks, warehouses, and analytics material.

Use root `data/` only for shared assets where no single owner exists. Otherwise
keep data with its owning app, service, worker, or library.

Database-specific assets live under the owner's `data/database/` folder, one
folder per asset kind.

Keep notebooks and exploratory data close to the owning domain unless the
project deliberately maintains a shared data science workspace.
