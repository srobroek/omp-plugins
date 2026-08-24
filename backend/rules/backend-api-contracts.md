---
name: backend-api-contracts
description: When editing API boundaries, schemas, generated clients, event contracts, or owner-local contracts.
globs: ["services/api/**", "services/graphql/**", "services/rpc/**", "services/webhooks/**", "schemas/**", "**/contracts/**"]
---

Use owner-local `contracts/` for private deployable-specific boundaries.
Shared or public contracts (OpenAPI, GraphQL, AsyncAPI, JSON Schema, protobuf,
event contracts) live in root `schemas/`. Generated clients live with consumers
or in independently versioned packages.
