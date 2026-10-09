---
name: architecture-docs-files
description: When inferring architecture or stack, or creating durable project knowledge files under docs/.
---

Store durable project knowledge under `docs/` and read those files before
inferring architecture or stack from generated files.

Preferred files:

- `docs/architecture.md` for system shape, boundaries, runtime topology, and important flows.
- `docs/stack.md` for languages, package managers, frameworks, infrastructure, data stores, and quality tools.
- For durable architectural decisions, follow `skill://quality-code-design/references/lifecycle.md` (Durable decisions), which says when to record one and where.
- `docs/engineering.md` for repo conventions, local workflows, and development constraints.
- `docs/operations.md` for deployment, hosting, secrets, monitoring, and runbooks.
- `docs/product.md` for user, domain, and product behavior that is not already owned by a spec.

When one of these files is missing and the task needs the information, create
the smallest useful file instead of embedding the knowledge in agent context
files.
