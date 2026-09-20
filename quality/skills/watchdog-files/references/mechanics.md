# Watchdog mechanics

Facts the advisor prompt depends on. Verified against `omp://advisor-watchdog.md` and a
434-session audit of delivered advisories.

## Discovery and prompt order

`WATCHDOG.md` and `WATCHDOG.yml`/`.yaml` load from the active agent dir, then from every
directory between the session cwd and the repository root, including `.omp/` subdirs.
Discovery does not stop at the nearest file: all of them load.

Prompt assembly order, earliest to latest:

1. built-in advisor system prompt
2. advisor context prompt
3. `WATCHDOG.md` blocks — user level first, then ancestors, then the narrowest directory
4. top-level YAML `instructions:` shared by every advisor
5. that advisor's own `instructions:`

Each `WATCHDOG.md` block is wrapped as `Especially pay attention to: <attention>…</attention>`.
Later blocks sit closer to the end of the prompt, so narrow directory guidance is more
prominent than a broad ancestor's. Per-advisor `instructions:` are appended to the default
prompt, never a replacement for it.

## Roster resolution

| Situation | Result |
| --- | --- |
| no roster entries discovered | one default advisor on `modelRoles.advisor` |
| entry with `model:` | that selector, `:level` suffix honoured |
| entry without `model:` | `modelRoles.advisor` |
| entry unresolvable | reported `no_model`, other entries still run |
| `enabled: false` | visible as paused, no runtime |
| same advisor name in two files | narrower file replaces the broader one |

## Delivery and timing

- An advisor reviews a delta, not the live workspace.
- `advisor.syncBacklog` (`off`/`1`/`3`/`5`) bounds how far behind it may fall; the primary
  waits up to 30s only while the backlog is at or above the threshold.
- `advisor.immuneTurns` routes further `concern`/`blocker` notes as non-interrupting asides
  for that many completed turns after one interrupt.
- `advisor.maxNotesPerUpdate` caps non-blocker notes per review; a `WATCHDOG.yml`
  top-level or per-advisor value overrides the setting.
- Measured on this user's sessions: blockers were delivered in 0.0s, concerns at p50
  182-230s and p90 1149-6396s, describing state 26-35 primary messages old.

## Subagents

Agent frontmatter `advisor: true` attaches an advisor on the `advisor` role; a string value
pins a model pattern. `task.agentAdvisor` (agent name → `on`/`off`/pattern) overrides the
frontmatter. An advised subagent reruns the same discovery for its own cwd, so prompts are
cwd-derived: there is no per-agent roster file.

## Tools

Default grant is `read`, `grep`, `glob`. A roster entry may grant any built-in, including
`edit`, `write`, `bash`, `eval`, which run in an isolated advisor tool session under normal
approval policy. An explicit `tools: []` leaves only `advise`.
