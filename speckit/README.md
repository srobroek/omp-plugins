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
| `speckit-bugfix` | Fix a defect. Bond `mol-speckit-bugfix` when the trail must be tracked. |

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
| `extensions/tasks-guard.ts` | write/edit of `specs/*/tasks.md` | Blocks when beads is active (`bd where` decides), because task state lives in beads. Fails open. |
| `extensions/taskstoissues-gate.ts` | bash | Blocks `speckit-taskstoissues` at the command slot, argv-parsed: wrapper chains (`sudo -u root …`, `env -S '…'`) resolve to the real executable, quoted mentions in `--title`/`--reason` pass. |
| `speckit-no-taskstoissues` (rule) | assistant stream | Interrupts on the slash form `/speckit.taskstoissues`. |
| `speckit-implement-deprecated` (rule) | assistant stream | Advisory on `speckit.implement`. |
| `speckit-tasks-md-bash` (rule) | edit/write of `specs/*/tasks.md` | Advisory companion to the gate. |
| `speckit-workflow` (rule) | always loaded | The workflow contract and command routing table. |

## Tools

- `speckit_setup`: idempotent bootstrap, called by the setup skill. `force=true`
  re-scaffolds an existing `.specify/`. `skipSpecify=true` installs only formulas
  and gitignore entries.

## License

Apache-2.0
