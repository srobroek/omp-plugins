---
name: toolchain-infrastructure
description: When choosing Terraform, CDK, Kubernetes, or Helm for infrastructure.
globs: ["**/*"]
---

# Infrastructure Defaults

Use Terraform or OpenTofu as the baseline for shared infrastructure.

Use CDK only when application code and AWS constructs are tightly coupled enough
to justify that tradeoff. Use Kubernetes and Helm only when the project already
has, or clearly needs, platform-level orchestration.
