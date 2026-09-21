# Verification

Run the real tools against the applied files. Every defect found while building this asset
library copied cleanly first, so reading an asset back proves nothing.

## Order

1. Compare every copied non-template destination byte for byte with its package asset by using
   `cmp`. Stop on the first mismatch. A shorter replacement that behaves similarly still fails.

2. Run each generator the plan listed, in this order. A later one reads what an earlier one
   wrote:

   | Command | Rebuilds |
   |---|---|
   | `python3 scripts/install_agents_index.py .` | `AGENTS.md`, `CLAUDE.md` |
   | `just just-sync` | the `justfile` import block |
   | `just hooks-merge` | `.pre-commit-config.yaml` |
   | `just ci-sync` | `.github/workflows/ci.yml` |
   | `just steering` | the generated blocks under `docs/agents/` |
   | `python3 scripts/fold_gitignore.py .` | `.gitignore` |

3. `just setup`. It installs the toolchain through mise, then each language's
   dependencies, then the hook shims.
4. `just check`. This is what CI runs, and it is the pre-merge gate Worktrunk enforces.
5. Run the staleness checks, which fail when a generated file no longer matches its sources:
   `just just-check`, and `just steering-check`.
6. Make a real commit that stages a file a hook watches, to prove the shims fire. A hook that
   passes when run standalone can still fail inside a commit, because the commit's git
   environment differs.

## What a report contains

Report per command: the command, its exit status, and its own output when it failed.

MUST Name every file written, with its plan class.

MUST Print the failing command's own output. A summary line hides a failed build, and
"setup complete" beside a red `just check` is the failure mode this rule exists for.

MUST Say that commit scopes are unrestricted when the user named none, and that the
allowlist is adopted by listing a vocabulary and re-running `just hooks-merge`.

MUST Say which settings are still gaps, and what breaks while each stays open. A refused
secret is a gap, and so is a repository that was not created.

## Known first-run failures, and what each means

| Symptom | Cause |
|---|---|
| `Selection 'DOC' has no effect because preview is not enabled` | `preview = true` missing from `ruff.toml` |
| `ruff check` red on `scripts/` before any project code exists | the `scripts/**` per-file-ignore block was dropped |
| `cargo deny check licenses` fails against the crate itself | `Cargo.toml` has no `license` key; `cargo init` writes none |
| `prek install` prints a note and writes no shim | an ambient global `core.hooksPath`; install with `--git-dir "$(git rev-parse --absolute-git-dir)"` |
| `hooks-merge` fails on a missing `yaml` module | it was run with a bare python3 instead of `uv run --no-project --with pyyaml` |
| `install_agents_index.py` returns `conflict` on `CLAUDE.md` | a brownfield `CLAUDE.md` whose class was never asked; ask `MERGE|OVERWRITE|SKIP` and pass it as `--claude` |
| `install_agents_index.py` returns `conflict` on `AGENTS.md` | a brownfield `AGENTS.md` that is a symlink; ask `MERGE|OVERWRITE|SKIP` and pass it as `--agents` |
| `no_force_push.sh` exits 2 with a usage line | the hook entry lost its branch argument; `git-actions.yaml` passes the accepted default branch |
| A `just` recipe reports success having done nothing | a `mapfile` or `readarray` call under macOS bash 3.2 |
| `mise install` succeeds and installs nothing | the config was untrusted; `mise trust --yes` first |
| A CI run fails at the SARIF upload rather than at the scan | the caller did not grant `security-events: write` |
| A pull request is unmergeable with no failing check | a required check gated at the `on:` level never ran |
| A repository reports zero rulesets and an unprotected branch | those are API state, and no committed file sets them |

## Reporting no verification

NOT Claiming a check that did not run. A tool the destination has no binary for is
reported as not run, with the binary's name, rather than omitted.
