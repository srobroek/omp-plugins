---
name: infrastructure-tfstate-guard
description: Never hand-edit Terraform state; require terraform state subcommands with a backup.
condition: ["(?i)terraform\\s+state\\s+(rm|mv|push)", "(?i)\\.tfstate"]
scope: "tool:bash, tool:edit(**/*.tfstate*), tool:write(**/*.tfstate*)"
interruptMode: never
---

Never hand-edit Terraform state files.

Use `terraform state` subcommands (`list`, `show`, `mv`, `rm`, `push`) only after
a backup of the current state. Plan first; do not `state rm`/`mv`/`push` as the
opening move.

`*.tfstate` and `*.tfstate.*` are not source. Edit HCL and let Terraform update
state. If a remote backend owns state, operate through that backend — do not
write a local copy over it.
