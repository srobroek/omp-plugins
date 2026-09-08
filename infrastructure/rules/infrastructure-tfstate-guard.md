---
name: infrastructure-tfstate-guard
description: Never hand-edit Terraform or OpenTofu state; require state subcommands with a backup.
condition: ["(?i)(?:terraform|tofu)\\s+state\\s+(rm|mv|push)"]
scope: "tool:bash, tool:edit(**/*.tfstate*), tool:write(**/*.tfstate*)"
interruptMode: never
---

Never hand-edit Terraform or OpenTofu state files.

Use the owning CLI's `terraform state` or `tofu state` subcommands (`list`, `show`, `mv`, `rm`, `push`) only after
a backup of the current state. Plan first; do not `state rm`/`mv`/`push` as the
opening move.

`*.tfstate` and `*.tfstate.*` are not source. Edit HCL and let the owning CLI update
state. If a remote backend owns state, operate through that backend — do not
write a local copy over it.
