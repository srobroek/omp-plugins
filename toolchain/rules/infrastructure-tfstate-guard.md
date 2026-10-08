---
name: infrastructure-tfstate-guard
description: Never hand-edit Terraform or OpenTofu state; require state subcommands with a backup.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:terraform|tofu)\\s+(?:-(?:\\\\\"|(?!\\\\n)[^\\s;&|\"])+\\s+)*state\\s+(?:rm|mv|push)\\b", "(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:rm|git\\s+rm)\\s+(?:(?:\\\\\"|(?!\\\\n)[^\\s;&|\"])+\\s+)*?(?:\\\\\"|(?!\\\\n)[^\\s;&|\"])*\\.tfstate", "(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:mv|cp)\\s+(?:(?:\\\\\"|(?!\\\\n)[^\\s;&|\"])+\\s+)+(?:(?:\\\\\"|(?!\\\\n)[^\\s;&|\"])*/)?(?:\\\\\"|\")?terraform\\.tfstate(?:\\\\\"|\")?(?=\\s*(?:$|[;&|)\"\\n]|\\\\n))", "(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:'[^'\\n]*'|\\\\\"(?:(?!\\\\\").)*\\\\\"|(?<!\\\\)\"(?:[^\"\\\\\\n]|\\\\.)*\"|(?!\\\\n)[^;&|\"'\\n])*?>\\s*(?:(?:\\\\\"|(?!\\\\n)[^\\s;&|\"])*/)?(?:\\\\\"|\")?terraform\\.tfstate(?:\\\\\"|\")?(?=\\s*(?:$|[;&|)\"\\n]|\\\\n))"]
scope: "tool:bash"
interruptMode: always
---

Never hand-edit Terraform or OpenTofu state files.

Use the owning CLI's `terraform state` or `tofu state` subcommands (`list`, `show`, `mv`, `rm`, `push`) only after
a backup of the current state. Plan first; do not `state rm`/`mv`/`push` as the
opening move.

`*.tfstate` and `*.tfstate.*` are not source. Edit HCL and let the owning CLI update
state. If a remote backend owns state, operate through that backend — do not
write a local copy over it.
