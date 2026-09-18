---
name: worktrunk-isolation-disabled
condition: ["(?s)\"isolated\"\\s*:\\s*true", "(?m)^\\s*isolated\\s*:\\s*true\\s*$"]
scope: "tool:task"
interruptMode: always
---

MUST NOT spawn an isolated subagent. OMP native isolation is retired: its
backends are filesystem clones of the whole checkout, so a child receives its own
copy of the ledger directory. An embedded single-file database that has been
copied is a second ledger — every claim, comment and closure the child writes is
invisible to its siblings and is discarded with the clone, while the parent still
believes the work is unclaimed.

MUST give each agent a git linked worktree instead. A worktree shares one
`.git` and one ledger with every sibling:
`wt switch -y --create --no-cd --base <base> --format json omp/agent/<bead-id>`.

Verify the setting with `omp config get task.isolation.enabled --json`; it must
report `false`. When it reports `true`, set `task.isolation.enabled: false` under
`task.isolation` in `~/.omp/agent/config.yml`. Reconfiguring the backend does not
help: there is no git-worktree isolation backend, so the only correct value is
off.
