# Worktrunk

Worktree discipline for agents working against a single embedded Beads store.

The package does exactly one thing in code: it refuses OMP native isolation. Everything else it
used to enforce is steering, because steering is what the evidence supports.

## Registered extension

### `isolation-precheck`

Refuses a `task` call that requests `isolated: true`, in both the flat shape and the batch
`tasks: [{ isolated: true }]` shape.

Native isolation copies the whole checkout with a filesystem clone. There is no git-worktree
backend, so it cannot be reconfigured into the worktree model, only turned off. A cloned checkout
carries its own `.beads`, and a copied embedded Dolt database is a second ledger: claims, comments
and closures written in the clone are invisible to every sibling and are discarded with the clone.

The refusal is unconditional and has no opt-out setting, because the failure it prevents is silent
and unrecoverable and native isolation has no legitimate use against an embedded ledger.

It is also the narrowest gate the harness allows: a single string compare on the tool name, then a
structural walk of one argument. It reads no settings, touches no filesystem, spawns no
subprocess, runs no `git`, and registers no `session_start` handler — so it cannot be slow, cannot
time out, and cannot refuse a call it has no business refusing.

## Rules

Discovered by directory convention; the manifest lists no rules.

### `worktrunk-worktree-required`

Work in a git linked worktree, never in the canonical checkout. Gives the exact non-interactive
`wt switch` invocation, requires the run's recorded base commit rather than the default branch tip,
and requires `wt step copy-ignored` so a focused test run does not fail with a missing-module error
that reads as broken code.

### `worktrunk-isolation-disabled`

Keep `task.isolation.enabled: false`, verified with `omp config get task.isolation.enabled --json`.
The extension's refusal only fires once an isolated child has been attempted; this rule makes the
setting correct beforehand.

## What is deliberately not here

**The canonical-mutation gate.** Removed, with its command allowlist, branch-name policy, shell
tokenizer and topology probe. Its own capability inventory records no accidental canonical write
ever observed, while the guard itself produced five measured friction incidents: branch names
refused for not matching `omp/*`, an unresolved topology escalated into a session-wide stop that
also blocked read-only calls, a five-second synchronous probe stalling calls, a legitimate
`verify.sh` and `git worktree add` refused inside an unrelated clone, and a claim coupled to
filesystem setup.

A stray write into the canonical checkout lands in the lead's own working tree, where
`git status`, the diff and review all surface it, and it is recoverable. That is a different class
of failure from a forked ledger, and it does not justify a gate that fires on every tool call.

Anyone wanting mechanical enforcement should use a `bash.patterns` deny entry, which is the only
hard pre-execution bash boundary that holds in every approval mode. It is user-owned config with no
handler, no timeout and no blast radius beyond the pattern.

**Provisioning enforcement, stale-worktree cleanup, the canonical-staleness advisory, and
destructive-deletion provenance.** Removed earlier for the same reason: none of them protects the
embedded store or the canonical checkout.

**`worktrunk-bd-contention-retry`.** Moved to the beads package as `bdlite-contention-retry`. Its
retry policy concerns embedded-store writer contention and remote sync, not worktree isolation.
