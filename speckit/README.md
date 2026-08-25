# speckit

Beads-native SpecKit workflow, ported from `srobroek/speckit-conductor`.

Install this plugin in a repo that uses (or will use) SpecKit. Pair it with the
`beads` plugin. `build-formula` is **not** duplicated here — it already ships
in `beads`.

## Skills

| Skill | Use when |
|---|---|
| `speckit-setup` | Bootstrap `.specify/`, extensions, and copy formulas into `.beads/formulas/`. |
| `speckit-bugfix` | Fix a defect; bond `mol-speckit-bugfix` when the trail must be tracked. |

Call the `speckit_setup` tool from the setup skill rather than a bash script.

## Agents

| Agent | Spawn with |
|---|---|
| `speckit-sync` | `scope: drift` / `conflicts` / `both` |
| `speckit-verify` | `mode: requirements` / `tasks` |

## Formulas

Copied from the conductor package into `formulas/`. Setup installs them into
the repo's `.beads/formulas/`.

- Depth: `speckit-basic`, `speckit-lean`, `speckit-feature`
- Bonds: `mol-speckit-iterate`, `mol-speckit-fix-findings`, `mol-speckit-bugfix`, `mol-speckit-refine`

## Hook → construct mapping

| Source hook | Became |
|---|---|
| PreToolUse Write/Edit/apply_patch deny of `specs/*/tasks.md` when beads is active | `extensions/tasks-guard.ts` `tool_call` gate (`block: true`). Fail-open. Needs `bd where` evidence a regex cannot carry. |
| PreToolUse Bash write-to-tasks.md deny | Same gate (write-shape detector). |
| PreToolUse Bash advisory on any `specs/*/tasks.md` mention | TTSR `speckit-tasks-md-bash`, rescoped to `tool:edit`/`tool:write` on `specs/*/tasks.md` (`interruptMode: never`). The bash form advised against reads it permits (`cat specs/001-foo/tasks.md`). |
| PreToolUse Skill advisory on `speckit.implement` | TTSR `speckit-implement-deprecated`. |
| PreToolUse Bash `gh pr create\|edit` changelog reminder | Retired: `delivery-draft-pr-advisory` owns `gh pr create`, and the title-is-the-changelog line is prose in `delivery-git-workflow`. Two advisories on one command was noise. |
| UserPromptSubmit / UserPromptExpansion / PreToolUse:Skill dispatcher (`speckit_instructions.py` table) | `alwaysApply` rule `speckit-workflow` (static contract + command routing table). Per-command fire-at-invoke injection does not exist in OMP; the table is always-loaded instead. |
| `taskstoissues` deny | `extensions/taskstoissues-gate.ts` owns bash (argv). TTSR `speckit-no-taskstoissues` is slash-form only (`interruptMode: always`). |
| Gate resolved with `bd close` instead of `bd gate resolve` | Moved to the beads plugin, which owns `bd gate`: TTSR `beads-gate-close` plus the `bd-close-gate` extension. |
| `bd create` without `--spec-id` | Retired as a contextual false positive; spec linkage is prose in `speckit-workflow`. |

## What did not survive

- **Claude/Codex hook JSON** — no PreToolUse/UserPromptSubmit runtime.
- **Per-command additionalContext at slash-expansion time** — OMP has no
  UserPromptExpansion. The instruction table is in `speckit-workflow`.
- **Python scripts** (`speckit-tasks-guard.py`, `speckit-dispatcher.py`,
  `speckit-pr-title.py`, `speckit_instructions.py`, `setup-speckit.sh`) —
  replaced by TS + TTSR + the setup tool.
- **`specify integration switch` bounce / chmod repair of `.specify/scripts`** —
  still a specify-CLI concern; setup calls `specify init` and `extension add`
  but does not re-implement the switch dance. Re-run specify if command files
  are missing for an integration.
- **build-formula** — already in the beads plugin.

## Tools

- `speckit_setup` — idempotent bootstrap
- `speckit_tasks_guard` is not a callable tool; it is a `tool_call` handler
