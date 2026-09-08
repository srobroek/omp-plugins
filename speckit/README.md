# speckit

SpecKit workflow for OMP, tracked in beads:

- spec-driven setup
- a bugfix flow
- tasks.md protection
- workflow guards

Install alongside the `beads` plugin: the formulas assume a beads workspace,
and `build-formula` ships there.

## Skills

| Skill | Use when |
|---|---|
| `speckit-setup` | Bootstrap `.specify/`, extensions, and copy formulas into `.beads/formulas/`. |
| `speckit-bugfix` | Fix a defect. If you need a tracked trail, bond `mol-speckit-bugfix`. |

## Agents

| Agent | Spawn with |
|---|---|
| `speckit-sync` | `scope: drift` / `conflicts` / `both` |
| `speckit-verify` | `mode: requirements` / `tasks` |

## Formulas

Setup installs the bundled formulas into the repo's `.beads/formulas/`.

- Depth: `speckit-basic`, `speckit-lean`, `speckit-feature`
- Bonds: `mol-speckit-iterate`, `mol-speckit-fix-findings`, `mol-speckit-bugfix`, `mol-speckit-refine`

## Guards

| Guard | Surface | Behavior |
|---|---|---|
| `extensions/tasks-guard.ts` | write/edit of `specs/*/tasks.md` | When beads is active (`bd where` decides), blocks writes and edits because task state lives in beads. Fails open. |
| `extensions/taskstoissues-gate.ts` | bash | Blocks `speckit-taskstoissues` at command slots, including if/while/until conditions and then/do bodies. Wrapper chains resolve to the executable. Quoted mentions in `--title`/`--reason` pass. The gate is not a shell sandbox. |
| `speckit-no-taskstoissues` (rule) | assistant stream | Interrupts on the slash form `/speckit.taskstoissues`. |
| `speckit-implement-deprecated` (rule) | assistant text and bash | Advisory on `speckit.implement`. |
| `speckit-tasks-md-bash` (rule) | edit/write of `specs/*/tasks.md` | Advisory companion to the gate. |
| `speckit-workflow` (rule) | always loaded | The workflow contract and command routing table. |

## Tools

The setup skill calls `speckit_setup` to bootstrap the repository.
Failed required specify/catalog/extension/beads steps stop with `ok: false`.

| Option | Effect |
|---|---|
| `force=true` | Re-scaffolds `.specify/` only. |
| `skipSpecify=true` | Installs formulas and gitignore entries only. |
| `skipBeads=true` | Explicitly omits beads and formulas, leaving molecule workflows unavailable. |

Formula installation preflights every required source and destination. It rejects
symlinks and never overwrites divergent files. These checks do not provide
concurrency guarantees or roll back earlier successful CLI steps.

## License

Apache-2.0
