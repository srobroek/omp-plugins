# Worktrunk

Worktree discipline for agents working against a single embedded Beads store.

The package ships two registered extensions, two directory-discovered rules, and one
directory-discovered skill.

## Registered extensions

### `merge-policy-gate`

Blocks worker-to-epic `wt merge` calls unless they include both `--no-squash` and `--no-ff`,
and unless they run from the source worktree: `wt merge <target>` merges the current branch,
so a call whose current branch is the target (or unreadable, such as a detached HEAD) is
refused. Merges to the repository default branch are unchanged when run through `bash`.

The same policy covers `eval` code. A statically detectable merge with both history flags is
allowed; an unflagged or dynamically constructed merge is blocked because the eval gate cannot
resolve its target or working directory. Retry through `bash` from the source worktree with
`wt merge <target> --no-squash --no-ff` for worker-to-epic merges, or plain `wt merge` for the
default branch.


### `isolation-precheck`

Refuses a `task` call that requests `isolated: true`, in both the flat shape and the batch
`tasks: [{ isolated: true }]` shape.

Native isolation copies the whole checkout with a filesystem clone. There is no git-worktree
backend, so it cannot be reconfigured into the worktree model. A cloned checkout carries its own
`.beads`, and a copied embedded Dolt database is a second ledger: claims, comments, and closures
written in the clone are invisible to every sibling and are discarded with the clone. The refusal
is unconditional because that forked ledger cannot be recovered or reconciled with the original.

## Rules

Discovered by directory convention; the manifest lists no rules.

### `worktrunk-worktree-required`

Work in a git linked worktree, never in the canonical checkout. Gives the exact non-interactive
`wt switch` invocation, requires the run's recorded base commit rather than the default branch tip,
and gets provisioning from the post-start hook, which preflight verifies and `--apply` adds.

### `worktrunk-isolation-disabled`

Keep `task.isolation.enabled: false`, verified with `omp config get task.isolation.enabled --json`.
The extension's refusal only fires once an isolated child has been attempted; this rule makes the
setting correct beforehand.

## Skill

### `worktrunk-preflight`

Like the rules above, the skill is discovered by directory convention. It runs deterministic checks
before an agent run, focused test, or merge. Invoke it with:

```sh
python3 skills/worktrunk-preflight/preflight.py [--json] [--only ID] [--apply]
```

It is read-only unless `--apply` is passed. `--apply` runs only `wt config approvals add --yes`
when the hook-approvals check fails, then rechecks it.

It catches three measured defects:

- An `approval_required` hook state: an unapproved project hook is skipped rather than failed, so
  a `pre-merge` test hook that never runs is indistinguishable from one that passed.
- A project-config key that `wt` silently discards, measured as `▲ Project config has key merge which belongs in user config (will be ignored)`.
- A `[merge]` table in project config, which cannot preserve merge evidence because `wt` ignores
  it. The reliable control is explicit `wt merge --no-squash --no-ff` on every merge that must keep
  merge evidence, which is worker-to-epic; an epic-to-default merge may be plain or squashing.
