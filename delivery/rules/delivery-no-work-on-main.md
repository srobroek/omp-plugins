---
name: delivery-no-work-on-main
description: Abort a git commit that targets main or master.
condition: ["git\\s+commit[^\\n]*(?:\\s(?:main|master)(?:\\s|$)|\\s-b\\s+(?:main|master))"]
scope: "tool:bash"
interruptMode: always
---
Do not commit directly to main/master. Create or reuse a feature branch first.
