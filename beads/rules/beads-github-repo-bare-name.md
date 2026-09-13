---
name: beads-github-repo-bare-name
description: "The two beads GitHub mirror config keys that fail silently: github.repo takes a bare name, and github.org is never read."
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+config\\s+set\\s+github\\.repo\\s+\\S+/\\S+", "(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+config\\s+set\\s+github\\.org\\b"]
scope: "tool:bash"
interruptMode: always
---

Two mirror config keys fail silently, and this command is about to write one of
them.

`github.repo` holds the BARE repository name. `bd` joins it to `github.owner`,
so `owner/repo` requests `owner/owner/repo` and fails on every pull while
`bd github status` still reports configured. `github.owner` is the owner key,
not `github.org`; only the former is read.

```
bd config set github.owner <owner>
bd config set github.repo <bare-repo-name>
```
