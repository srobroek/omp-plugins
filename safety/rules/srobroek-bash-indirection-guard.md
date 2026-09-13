---
name: srobroek-bash-indirection-guard
description: A destructive command in command position whose target is an unexpanded variable, command substitution, or backtick expression cannot be verified as safe, so the call is aborted before execution.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:(?:then|do|else|sudo|command|env|exec|time|nohup|xargs)\\s+(?:-[-A-Za-z0-9]+\\s+)*|[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&\"']*\\s+){0,3}(?:(?:ba|z|k|da)?sh\\s+-[A-Za-z]*c\\s+\\\\{0,2}['\"]?)?\\\\{0,2}(?:\\/(?:[A-Za-z0-9_.-]+\\/)+)?(?:rm|rmdir|dd|mkfs(?:\\.[A-Za-z0-9]+)?|shred|truncate)\\s(?<!<<[\\s\\S]{0,400})(?:(?!\\\\n)[^;|&\\n]){0,200}?(?:(?<!\\s--\\s(?:(?!\\\\n)[^;|&\\n]){0,80}\")\\$\\{?[A-Za-z_]|\\$\\(|`)"]
scope: "tool:bash"
interruptMode: always
---

This destructive command targets an unexpanded variable, command substitution, or backtick expression, so its path cannot be verified. Resolve the target and re-issue a literal command; a quoted variable is safe only after a bare `--` end-of-options marker. This advisory checks only the bash tool-call arguments and is not a substitute for the enforced command deny list.
