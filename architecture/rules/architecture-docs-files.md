---
name: architecture-docs-files
description: When inferring architecture or stack, or creating durable project knowledge files under docs/.
globs: ["docs/**"]
---

Store durable project knowledge under `docs/` and read those files before
inferring architecture or stack from generated files.

Preferred files:

- `docs/architecture.md` for system shape, boundaries, runtime topology, and important flows.
- `docs/stack.md` for languages, package managers, frameworks, infrastructure, data stores, and quality tools.
- `docs/decisions.md` or `docs/decisions/*.md` for durable architectural decisions.
- `docs/engineering.md` for repo conventions, local workflows, and development constraints.
- `docs/operations.md` for deployment, hosting, secrets, monitoring, and runbooks.
- `docs/product.md` for user, domain, and product behavior that is not already owned by a spec.

When one of these files is missing and the project setup or brownfield workflow
needs the information, create the smallest useful file instead of embedding the
knowledge in agent context files.
