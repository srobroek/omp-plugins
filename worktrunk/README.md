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

`delivery_land` and `delivery_cleanup` are judged by the session cwd and by every path they name. Both tools resolve the receipt, worktree, and branch from their execution directory. A payload without a path still mutates that repository, so both tools require a live linked worktree as the session cwd.

The gate judges declared path parameters however the caller spells them: `worktree` on both tools and `receipt` on `delivery_cleanup`. A relative value resolves against the same session cwd. Therefore, `worktree: "../../canonical"` earns the same refusal as `worktree: "/abs/canonical"`, while a relative value inside the worktree is allowed.

A key represents a path only when the tool declares it as one. The same key on another tool names nothing.

Every other call that resolves to no filesystem path is allowed. A pathless device call, internal URL, web URL, and bead id name no working tree that this gate can attribute. The gate therefore has nothing to contain.

The same rule applies to an unenumerated tool. Absence from the tables removes only the read-only exemption. Such a tool may not carry a canonical path, but its pathless calls remain allowed.

The gate applies these rules in order. The tables decide whether canonical paths are allowed. The resolved paths decide everything else. Tests cover both directions.

Uncertainty refuses. The gate refuses a `git` process that does not answer, a payload that does not parse, or a session cwd that no longer exists. Only a `git`-confirmed session outside every repository stands the gate down.

The gate is an accident guardrail, not a sandbox. A cooperative process can still write an absolute path through an allowed command or a shell redirection, so canonical checkouts remain protected by the worktree policy rather than by a claim of complete containment.
