# Hook recipes, imported by the root justfile.

# hooks-merge goes through uv, because merge_hooks.py imports yaml and a bare
# python3 -- system or mise-pinned -- ships without it: a fresh clone of every
# profile failed setup exactly here. `--no-project` keeps the run out of any
# .venv the repo carries.

# Rebuild .pre-commit-config.yaml from .pre-commit.d/
[group('hooks')]
hooks-merge:
    @uv run --no-project --with pyyaml python3 scripts/merge_hooks.py .

# `--git-dir` rather than `core.hooksPath`. prek declines to install while an ambient
# global hooksPath is set, which is what a machine-wide hook manager leaves behind:
# verified against prek 0.4.11, where it printed a note and wrote NO shim, so a fresh
# clone silently had no hooks. Passing the directory sidesteps that entirely.
#
# `--absolute-git-dir` resolves per checkout, so a linked worktree installs into its own
# hooks directory rather than the primary's. A worktree's $GIT_DIR is
# `.git/worktrees/<name>/`, which is where git looks for its hooks, so shims in the
# primary would never fire there.
#
# `wt`'s blocking pre-start runs `just setup` per worktree, so a new worktree hooks
# itself without anyone remembering to.

# Install the hook shims into this checkout
[group('hooks')]
hooks-install: hooks-merge
    prek install --git-dir "$(git rev-parse --absolute-git-dir)"

# Run every hook over every tracked file, as CI does
[group('hooks')]
hooks-all: hooks-merge
    prek run --all-files

# Run one group: hygiene, security, quality, docs, or beads
[group('hooks')]
hooks-group group: hooks-merge
    prek run --group {{ group }} --all-files
