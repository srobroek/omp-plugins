---
name: srobroek-worktree-tmp-guard
description: Refuse creating a git worktree under /tmp, where a container bind mount cannot see it
condition: ["(?i)\\b(git\\s+worktree\\s+add|wt\\s+(switch|new|co|agent))\\b[^\\n]{0,200}?(?<![\\w~.])(?:\\/private)?\\/tmp\\/"]
scope: ["tool:bash"]
interruptMode: always
---

# Do not create a worktree under /tmp

A container bind mount of a path the runtime does not share **succeeds** and yields
an empty directory. Docker Desktop shares `$HOME`, but not `/private/tmp` or
`/private/var`. So a worktree created under `/tmp` looks fine on the host and is
invisible inside the container.

The failure that follows says nothing about the cause:

```
fatal: not a git repository (or any parent up to mount point /private/tmp)
Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).
```

That matters here because Git Defender makes `dgit` the only route to github.com,
and `dgit` runs git inside a container. A worktree under `/tmp` therefore cannot
push at all, while the same worktree under `$HOME` works.

Verified: a bind mount of `/private/tmp/<wt>` lists only `.` and `..` inside the
container, while `/Users/<user>/<wt>` lists the full tree.

## Do this instead

1. Put the worktree under `$HOME`. `git worktree add ~/wt/<name>` is enough.
2. For a worktrunk lease, use the configured `worktree-path`, which already
   resolves to `~/tmp/worktrees/{{ repo }}/{{ branch }}` — under `$HOME`, and not
   what this rule is about.
3. If a worktree genuinely must live outside `$HOME`, add that path to the
   runtime's file-sharing settings first, and expect it to be machine-local.

`~/tmp/...` is fine and does not trigger this rule: it contains the substring
`/tmp/` but resolves under `$HOME`. Only a path that starts at `/tmp` or
`/private/tmp` does.

This rule is advisory-strength. It fires on the assistant's token stream, and
`ttsr.repeatMode` governs how often it re-arms within a session.
