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

### Routine human approvals

Use `speckit_start` in OMP or run this plugin's `tools/spec-start.ts` with Bun.
Pass `--spec NNN-slug` and `--workspace` with the canonical repository root containing `.beads`.
The starter asks before creating approvals and persists the answer on the workflow root.
Each Beads read or one-bead write gets its own 120 s bound, sized for a cold store; `mol pour` and `gate resolve` run until done or cancelled.
A store-lock wait that runs out, a command past its bound, or cancellation reports `INCOMPLETE` with the step reached and whether a pour was issued; inspect the run before retrying.
Setup must install the selected formula first; the low-level formula requires explicit `autonomous` and has no default.

The CLI and tool share the same approval policy and hold the Beads embedded-write lock for the whole start, so concurrent starts for a spec cannot pour duplicate runs.
When package resolution cannot find Beads, pass its installed package root with
`--beads-plugin` (CLI) or `beadsPlugin` (tool).
The selected Beads package must export `./embedded-write`; no bd command runs outside its lock.

For an explicit noninteractive answer, provide `--approvals yes|no` and `--decision`.
An existing gated run additionally requires separate `--migrate` consent before declining routine approvals.
The tool uses `approvals`, `decision`, and `migrate` for those same selections.
Use `--root` or `root` to select one run when the spec has multiple recorded runs.

| Human approvals | Formula selection | Routine sign-offs |
|---|---|---|
| Required | `autonomous=no` | Retained |
| Declined | `autonomous=yes` | Omitted |

Record `human_approvals`, `autonomous`, and the explicit decision on the workflow root.
Resumed runs reuse that choice and display it; runs without a choice ask before advancing.
Existing gated runs require explicit migration consent and retain their approval history.
Never silently resolve an existing human approval.

Clarification, analysis, independent reviews, verification, and tests remain required.
The choice does not waive consequential safety/provider confirmations or unresolved requirements.
Only actual dependency consumers wait for an approval; unrelated work can continue.


## Guards

| Guard | Surface | Behavior |
|---|---|---|
| `extensions/tasks-guard.ts` | write/edit/ast_edit of `specs/*/tasks.md` | When beads is active (`bd where` decides), blocks writes and edits because task state lives in beads, including hashline headers, `MV` destinations, and rename destinations. Fails open. |
| `speckit-no-taskstoissues` (rule) | assistant text, `read` | Interrupts a read of the `speckit-taskstoissues` skill; advises on a line-start slash command. |
| `speckit-implement-deprecated` (rule) | assistant text | Advisory on the slash form `/speckit.implement`. |
| `speckit-workflow` (rule) | SpecKit or `.specify/` work | The beads workflow contract and command routing table. |

## Tools

The setup skill calls `speckit_setup` to bootstrap the repository.
Every phase reports `done`, `skipped` (already present), or `failed`; a failed phase stops with `ok: false`, and a rerun resumes by skipping completed phases. Each phase has its own timeout.

| Option | Effect |
|---|---|
| `workspace` | Repository root, resolved against the caller's working directory; defaults to it. |
| `installAllowed=true` | Registers the public community catalog as an install source. Opt in only after vetting the required extensions; without it the catalog is not registered. When `SPECKIT_CATALOG_URL` is set, specify reads only that catalog, so this phase is skipped. |
| `force=true` | Re-scaffolds `.specify/` only. |
| `skipSpecify=true` | Installs formulas and gitignore entries only. |
| `skipBeads=true` | Explicitly omits beads and formulas, leaving molecule workflows unavailable. |

Formula installation preflights every required source and destination. It rejects
symlinks and never overwrites divergent files. These checks do not provide
concurrency guarantees or roll back earlier successful CLI steps.

## License

Apache-2.0

## Works with quality

`speckit-bugfix` loads `skill://quality-code-design` and its references. Install `quality` too; without it the skill reports the missing guidance.
