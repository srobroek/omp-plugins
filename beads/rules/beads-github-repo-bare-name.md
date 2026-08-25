---
name: beads-github-repo-bare-name
description: "The two beads GitHub mirror config keys that fail silently: github.repo takes a bare name, and github.org is never read."
condition:
  - "\\bbd\\s+config\\s+set\\s+github\\.repo\\s+\\S+/\\S+"
  - "\\bbd\\s+config\\s+set\\s+github\\.org\\b"
scope: "tool:bash"
interruptMode: always
---
Two mirror config keys fail silently, and this command is about to write one of them.

`github.repo` holds the BARE repository name. bd joins it to `github.owner`, so
`owner/repo` here requests `owner/owner/repo` and 404s on every pull -- and
`bd github status` still prints `Status: ✓ Configured` while that happens, so the
status check does not catch it (verified 2026-07-28).

`github.owner` is the owner key, not `github.org`. Only the former is read, so a
workspace carrying just `github.org` reports `github.owner is not configured` even with
a valid token.

```
bd config set github.owner <owner>
bd config set github.repo <bare-repo-name>
```
