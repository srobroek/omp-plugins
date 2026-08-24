# Gates -- human decisions and external waits

A gate makes "do not proceed without X" a bead in the DAG rather than a convention an agent must recall.

```toml
[[steps]]
id = "approve-release"
type = "task"
needs = ["verify"]
description = "Sign-off. Close the gate only after the user approves."

[steps.gate]
type = "human"
```

`[steps.gate]` must be a TOML **table**, not a string.

At pour a gated step yields **two** beads -- the step, and `Gate: <type>` with id
`<formula>.gate-<step-id>`:

```
- approve-release   (from rel.approve-release)
- Gate: human       (from rel.gate-approve-release)
```

## The type vocabulary

| type | waits for | closed by |
|---|---|---|
| `human` | a manual decision | `bd gate resolve <id>` only |
| `timer` | elapsed `timeout` | `bd gate check` |
| `gh:run` | a GitHub Actions workflow | `bd gate check` via `gh run view` |
| `gh:pr` | a PR merge | `bd gate check` via `gh pr view` |
| ~~`bead`~~ | -- | **DEAD.** Multi-rig routing removed; permanently open |

Four fields:

| field | meaning |
|---|---|
| `type` | required |
| `id` | which workflow or resource, e.g. `release.yml` |
| `await_id` | the target, e.g. a PR number. `bd gate discover` finds it for `gh:run` |
| `timeout` | Go duration: `30m`, `1h`, `24h` |

```toml
[steps.gate]
type = "gh:run"
id = "release.yml"
timeout = "30m"
```

Verified: `timeout` survives cook, and a `timer` gate auto-resolves --
`bd gate check` reported `resolved - timer expired 2s ago`.

## An unrecognised type stalls silently

Validation happens at neither cook nor pour. `type = "bogus-nonsense"` cooked, poured as an open gate
in `bd gate list`, and then:

```
$ bd gate check
Checked 0 gates: 0 resolved, 0 escalated, 0 errors
```

**Skipped, not errored.** The step waits forever under automation with nothing reporting why.
`bd gate resolve <id>` still closes it by hand, so it is a stall rather than a deadlock -- but the cause
is invisible. Assert the vocabulary in CI; the tool will not.

## Nothing runs `bd gate check`

There is **no daemon**. Three patterns exist and no more:

| Runner | Shape |
|---|---|
| CI step | Add `bd gate check` to the workflow |
| Cron | `*/5 * * * * cd /path/to/repo && bd gate check` |
| Agent hook | At session start, or after PR operations |

`bd hooks` installs git hooks only; the Claude and Codex integrations install `SessionStart` to
`bd prime` only. **Decide the runner before designing a non-`human` gate**, or it is decoration.

`bd gate check --escalate` marks failed `gh:*` gates for attention -- that is what makes a CI-bounce path
work.

## Resume

Discovery-based: **`bd ready --gated`**.

Two traps. `bd mol ready --gated` errors with `unknown flag: --gated` even though the binary's own help
documents that form. And `--gated` returns a molecule only when the gate is closed **and every other
predecessor is closed** -- probed: resolving a gate whose step still had an open non-gate predecessor left
`bd ready --gated` reporting `No molecules ready for gate-resume dispatch`. A dispatcher polling only
`--gated` misses work that became ready by the ordinary path. Poll `bd ready` too.

## Command surface

`bd gate list [--all]` · `check [--type=... --escalate]` · `resolve <id>` · `create --blocks <id>` ·
`show` · `discover` · `add-waiter`

## The override trap

A child that redeclares a gated step **without** repeating `[steps.gate]` produces a molecule with no
gate bead at all:

| child declares | poured |
|---|---|
| step retitled, gate omitted | step present, **no gate** |
| step retitled, gate block repeated | step plus `Gate: human` |

Override replaces the whole step, and the gate is part of it. Nothing warns. A silently missing approval
looks identical to a working molecule until an unapproved step has run.
