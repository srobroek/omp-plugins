---
name: speckit-pr-title
description: Advises that a squash-merge PR title becomes the changelog entry.
condition: ["gh\\s+pr\\s+(create|edit)|gh-api\\.py.*pr create|glab\\s+mr\\s+create"]
scope: "tool:bash"
interruptMode: never
---

PR TITLE = CHANGELOG ENTRY (via squash merge). Write for end users.

TITLE FORMAT:
- Minor fix: "fix: catalog refresh fails when offline"
- Minor feature: "feat: show version at startup for diagnostics"
- Major feature: "feat: automatic software detection via Windows registry and WMI"
- Breaking change: "feat!: migrate config from TOML to SQLite-backed storage"
- NEVER include spec IDs, task refs, phase names, or internal jargon

PR BODY: scale detail to significance. Major features get Summary / What's new /
Breaking changes. Minor changes get a short Summary. Spec context goes under
## Spec Context at the bottom, never in the title.
