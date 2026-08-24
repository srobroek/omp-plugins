---
name: infrastructure-platform
description: When editing infrastructure, platform code, IaC, CI/CD, environments, policies, or observability infra.
globs: ["infrastructure/**", "**/*.tf", "**/*.hcl", ".github/workflows/**"]
---

Use this for infrastructure, platform code, deployment config, CI/CD,
Terraform, OpenTofu, CDK, Kubernetes, Helm, environments, policies, and
observability infrastructure.

Use root `infrastructure/` for shared platform and IaC. Keep service-local
deployment config with the owning deployable when it is not shared platform
state.
