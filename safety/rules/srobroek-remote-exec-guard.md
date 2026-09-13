---
name: srobroek-remote-exec-guard
description: Aborts a bash call that would execute remotely fetched content, before the fetch runs.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:(?:then|do|else|sudo|command|env|exec|time|nohup|xargs)\\s+(?:-[-A-Za-z0-9]+\\s+)*|[A-Za-z_][A-Za-z0-9_]*=[^\\s;|&\"']*\\s+){0,3}(?:(?:ba|z|k|da)?sh\\s+-[A-Za-z]*c\\s+\\\\{0,2}['\"]?)?(?:(?:curl|wget|fetch)(?:(?!\\\\n)[^|\\n]){0,200}\\|\\s*(?:sudo\\s+)?(?:ba|z|fi)?sh\\b|eval\\s+\\\\{0,2}[\"'`]?\\$\\(\\s*(?:curl|wget|fetch)\\b|(?:nc|ncat)(?=\\s)(?:(?!\\\\n)[^|;\\n]){0,120}\\s-[A-Za-z]{0,6}e\\b)"]
scope: "tool:bash"
interruptMode: always
---

This command would execute content fetched from the network without review: a download piped into a shell, an `eval` wrapping a fetch, or a netcat invocation with `-e`. It is aborted before execution. Download to a file, inspect it, and run only an explicitly reviewed script.
