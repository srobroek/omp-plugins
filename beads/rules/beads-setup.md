---
name: beads-setup
description: Use for Beads initialization, `bd` version checks, store migration, repositories without `.beads/`, ledger-bearing clones, git/Dolt remote checks, or `bd where` reporting no beads database found.
---
# VERSION
Accept only stable `bd` 1.3.0 or later.
# MIGRATION
Migrate a repository in this order:

1. Create a native backup, so a failed migration is recoverable.
2. Confirm that every active client runs a compatible version.
3. Run the migration.
4. Verify that the repository is healthy.
# DETECT
`bd where` exits 0 → Beads is initialized; skip initialization.
Otherwise, run `git ls-remote origin refs/dolt/data`. Non-empty output → the
ledger exists remotely: run `bd bootstrap --yes`, never `bd init`. If `bd`
warns that `.beads` has permissions 0750, run `chmod 700 .beads`.
# NEW LEDGER
MUST require git `origin` first: run `git remote -v`. If it is absent, add or
confirm the code remote with the user's repository URL before initialization.
Run `BD_NON_INTERACTIVE=1 bd init --init-if-missing --skip-hooks --skip-agents`.
The issue prefix defaults to the directory name; add `--prefix PREFIX` only when
the user names another prefix.
It auto-commits `.beads/{.gitignore,README.md,config.yaml,metadata.json}` and
`.gitignore` on the CURRENT branch. Run it on the branch carrying the setup
change. `--skip-agents` prevents writing or committing `AGENTS.md`, `CLAUDE.md`,
`.agents/.codex/.cursor` files. Ignore the `Git upstream not configured / git
remote add upstream` hint: it is a fork-workflow hint, not ledger sync.
The generated `.beads/README.md` shows `bd update ID --status done`; replace that
example with `bd close ID --reason "REASON"` in the setup change.
# REMOTE
MUST verify `bd dolt remote list` shows `origin git+ssh://git@github.com/OWNER/REPO.git`
(or git+https / git+file). Only when it prints `No remotes configured.` run
`bd dolt remote add origin git+ssh://git@github.com/OWNER/REPO.git`, using the
same repository as the code. The ledger lives under `refs/dolt/data`, separate
from branches. NEVER re-add an existing name: `bd dolt remote add` silently
replaces it.
# FIRST PUSH + PROOF
`bd dolt push` MUST print `Push complete.`. Prove it with
`git ls-remote origin refs/dolt/data` returning non-empty output. `bd dolt push`
can exit 0 and push nothing without a remote; exit status is not proof.
# VERIFY
Run `bd where`, `bd dolt status`, and `bd dolt remote list`. Run
`bd hooks install --beads` only when the project owns its git-hook bundle and
the hooks directory contains no binary executable; otherwise retain those hooks.
# NEVER
NEVER use `bd init --reinit-local`, `--force`, `--discard-remote`,
`--destroy-token`, or `--from-jsonl` without explicit user direction. NEVER use
`--server`, `bd dolt start`, or any Dolt server. NEVER use `bd github`, `bd jira`,
`bd linear`, `bd ado`, or `bd federation` for ledger sync; they mirror issues to
external trackers.
# COMMAND DISCOVERY
When an operation is not covered by `bd prime`, `rule://beads-ledger`, or this
rule, read `bd COMMAND --help` for that command. Do not browse top-level
`bd --help` or try integration commands.
