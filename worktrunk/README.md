# Worktrunk

Worktrunk manages linked worktrees.

## Rules

Use worktrees for mutations.
Native isolation is off.
Retry contention.

## Gate

The gate checks mutations.
The gate rejects the canonical root.
Read-only tools are exempt.
Unknown paths block.

## Precheck

### `worktree-gate`

Most calls are judged by the filesystem paths their arguments resolve to. A path must be physically inside a linked, non-canonical worktree of the repository that owns it; a path outside that worktree is refused. Path ownership is resolved from the deepest existing directory above the target, not from the session's repository or cwd. A target inside no repository at all is scratch space and stays writable.

Read-only tools are exempt by name, including the two delivery tools that only inspect: `delivery_orient` and `delivery_hygiene_report` may run from the canonical checkout, as may the mode-dependent tools in their reading modes.

The ledger tool `bd_reconcile` is exempt while its payload names no filesystem path, in every mode it runs, and is judged on any path it does name. The exemption tests the payload, not a `cwd` argument, which is why it covers a tool that declares none. The same holds for the `orc_*` ledger tools: a bead id under `targets` is not a path, and a `cwd` pointing at the canonical checkout is.

`delivery_land` and `delivery_cleanup` are judged by the session cwd as well as by the paths they name, because they resolve the receipt, the worktree and the branch from the directory they run in: a payload that names no path still mutates that repository, so both require a live linked worktree as the session cwd.

Every other call that resolves to no filesystem path is allowed. A pathless device call, an internal URL, a web URL and a bead id name no working tree this gate can attribute, so there is nothing to contain. An unenumerated tool name is still mutating: only the names in the tables above are exempt.

Uncertainty refuses. A `git` that does not answer, a payload that will not parse, and a session cwd that no longer exists are all refusals; only a `git`-confirmed session in no repository stands the gate down.

The gate is an accident guardrail, not a sandbox. A cooperative process can still write an absolute path through an allowed command or a shell redirection, so canonical checkouts remain protected by the worktree policy rather than by a claim of complete containment.
