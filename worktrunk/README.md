# worktrunk

The worktrunk plugin keeps every agent's writes inside a git linked worktree of the project it is working on, and refuses to start work under OMP native isolation.

Both concerns are OMP-wide rather than orchestration-specific: "the agent mutated the shared checkout" and "the isolated clone forked the ledger" happen in ordinary sessions too, so they ship here and other plugins consume them instead of reimplementing them.

## Rules

| Name | When |
| --- | --- |
| `worktrunk-worktree-required` | Always applied. Claim, create a worktree, work by absolute path, never touch the canonical checkout. |
| `worktrunk-isolation-disabled` | A `task` call authors `isolated: true`. |
| `worktrunk-bd-contention-retry` | Assistant text or thinking names one of the store's five verbatim contention messages. |

`worktrunk-bd-contention-retry` matches only the five strings that are source constants in the store: the two workspace-gate messages a command actually prints, plus `lock busy: held by another process`, `lock already held by another process`, and `workspace gate busy`. It does not match `database is locked`, which is a documentation paraphrase, nor either `warning: workspace gate … continuing ungated` line, which report commands that ran.

TTSR conditions match assistant-produced streams — prose, thinking, and tool arguments — not tool results, so this rule fires when the agent reports or reasons about contention rather than the instant the store prints it. That is the moment the decision to escalate or retry is made.

## Extensions

### `worktree-gate`

A `tool_call` gate that refuses a mutation whose target is not physically inside a worktree that `git worktree list --porcelain` reports for this repository and that is not the canonical root. Membership, not a naming convention, is what makes the worktree requirement enforceable.

A direct-main repository may authorize canonical mutation only when its trusted committed policy contains the exact line `MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.` The call must use `cwd` resolving to that canonical checkout and `env: { DELIVERY_ALLOW_PRIMARY_CHECKOUT: "1" }` as structured data. Inline assignments and shell wrappers do not authorize. Authorized calls continue to downstream gates; the separate direct-main commit decision still applies.

| Tool | Checked |
| --- | --- |
| `write` | `path`; an `xd://<tool>` target is reclassified by that device's own rule against its JSON `content` |
| `edit` | every target `editInspect` reports for the payload, including a `MV` destination |
| `ast_edit` | the non-glob base of every `paths` entry |
| `bash` | the effective cwd — `resolveToCwd(input.cwd, sessionCwd)`, or the session cwd when `cwd` is omitted |
| `eval` | the effective cwd |
| any other tool | every argument under a path-shaped key, plus every absolute or `~`-rooted string |

Read-only tools (`read`, `grep`, `glob`, `ast_grep`, `lsp`, `task`, `hub`, and the rest) are exempt: the gate blocks mutation, not inspection. `security_scan` is not among them — it writes under `output_root` and reads a knowledge base by path, so it is checked like any other tool. Every other tool name is treated as mutating, because `toolName` is an unrestricted string and allow-by-omission is how a guardrail stops guarding an unenumerated device or MCP tool.

OMP normalizes paths and resolves cwds with its own `resolveToCwd`. Containment compares the realpath of each side's deepest existing ancestor. Canonical authorization uses only the structured cwd, exact structured environment value, and trusted committed policy.

The gate refuses uncertainty: an `edit` payload without a parseable target, an unresolved `cwd`, a canonical bash call without a structured grant that matches no bootstrap allowlist shape, and any thrown classification. A failed `git` query is also uncertainty: a missing binary, the 5 s timeout, or another unexpected non-zero exit blocks mutation. Only git's own "not a git repository" diagnosis makes the gate inert. Failures are not cached; after git recovers, the next call is decided normally. A cached "no repository" is dropped when `git init` or `git clone` is observed.

An agent's first action runs from the canonical checkout because a spawned child inherits its parent's working directory. The closed bootstrap allowlist covers `wt switch` in its create and `pr:<N>` forms, `wt list`, `wt config show`, `wt step prune --dry-run`, read-only `git`, and every `bd` call. Without a structured canonical grant, shell metacharacters (`;`, `&`, `|`, a backtick, `$(`, `>`, `<`, or a newline) disqualify a command.

This is an accident guardrail, not a sandbox. A cooperative agent stops writing to the canonical checkout by mistake; a process whose cwd is a worktree can still write any absolute path through `git -C <canonical>`, a redirection, or `eval`, and the gate does not pretend to prevent that. Canonical is never a merge target, so nothing legitimate writes there anyway.

One bounded gap follows from the same D3 accident-guardrail scope. On an unenumerated tool, a **relative** path under a key the gate does not recognize as path-shaped — `mcp__fs_write {"name": "src/probe.ts"}` — is not checked, because on an arbitrary tool any short string could be a name rather than a path and refusing every one of them would refuse ordinary work. Absolute paths, `~`-rooted paths, and every recognized path key are checked whatever the tool. Add the key to the gate's path-key table when a tool in use spells its target differently.

### `isolation-precheck`

Reports `task.isolation.enabled` at session start when it is on, and refuses any `task` call carrying `isolated: true` in either wire shape. The refusal is the enforceable half: the setting can be re-enabled after a session starts, so a start-time check alone would miss it.
