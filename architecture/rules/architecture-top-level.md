---
name: architecture-top-level
description: When choosing or changing repository top-level directories or capability-first layout.
---

Prefer these top-level directories when the project shape needs them:

- `apps/` for user-facing surfaces: web, admin, mobile, desktop, marketing, and docs.
- `services/` for long-lived backend deployables: API, GraphQL, RPC, webhooks, auth, billing, and notifications.
- `functions/` for serverless handlers, nested by platform such as `aws-lambda` or `cloudflare`.
- `workers/` for background jobs, queues, schedulers, and consumers, nested by platform.
- `libs/` for internal shared code by architectural role.
- `packages/` only for externally published or independently versioned packages.
- `schemas/` for shared or public contracts.
- `data/` for shared data assets where no single owner exists.
- `infrastructure/` for shared platform and IaC.
- `tools/` for maintained CLIs, generators, MCP implementations, and reusable developer tooling.
- `scripts/` for thin automation.
- `docs/`, `specs/`, `tests/`, `assets/`, and `archive/` for cross-cutting project material.
