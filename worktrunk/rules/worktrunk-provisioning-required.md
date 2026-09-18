---
name: worktrunk-provisioning-required
alwaysApply: true
---

MUST verify before starting work in a repository that its Worktrunk provisioning is
customised for that project. Require both committed files: `.config/wt.toml` for
the project's hooks and step configuration, and `.worktreeinclude` listing the
gitignored directories a fresh worktree needs. Neither is global; without them a
repository gets no project provisioning.

MUST author each missing file, customised for that repository, before
proceeding with the work. A verification that stops at "absent" provisions nothing.
Where a project cannot carry them, record that and the reason on the governing bead.

`.worktreeinclude` is what makes `copy-ignored` do anything. The step is gated by
`--require-include` and silently no-ops without that file. Name the dependency
directories the repository needs: `node_modules/` for bun or npm, `target/` for
cargo, `.venv/` for uv or pip, and `vendor/` for go.

MUST run `wt step copy-ignored` in each newly created worktree before running
tests. It makes a reflink or copy-on-write clone where the filesystem supports it,
so copying a large dependency directory is near-free on APFS.

NEVER substitute a dependency install for provisioning. Ecosystems differ per
repository, and installing on every worktree creation spends agent time for a
result that copying already achieves.

An unprovisioned worktree can fail a focused test with a missing-module or
missing-export error that looks like broken code. Today one worker reported
`0 pass, 1 fail, 1 error` on `SyntaxError: Export named
'lifecycleBdEnvironment' not found` and blamed its test file, but the checkout
simply had no `node_modules`.
