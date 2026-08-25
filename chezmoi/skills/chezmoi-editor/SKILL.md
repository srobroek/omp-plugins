---
name: chezmoi-editor
description: Edits chezmoi-managed dotfiles at their authoritative source. Use when changing dotfiles, templates, symlinks, private files, or global agent and tool configuration.
---

# Chezmoi Editor

Use this skill when a task changes files managed by chezmoi. Resolve the managed
source first; do not edit the rendered live target as the durable fix.
The `chezmoi-guard` extension blocks edits to live chezmoi targets and reminds you to apply after
source edits; `secret-commit-gate` blocks a commit that stages a plaintext credential.

## Workflow

1. Determine whether the target is managed:
   - `chezmoi managed`
   - `chezmoi source-path <target>` when a specific target is known
   - existing symlink/source layout when chezmoi cannot resolve it directly
2. Edit the source under the chezmoi source tree, not `$HOME` runtime output.
3. Use native chezmoi names for dotfiles, executables, private files, readonly
   files, symlinks, and templates.
4. Keep secrets in your credential manager or vault, never plaintext (see
   `skill://chezmoi-editor/references/secrets.md`).
5. Preview with `chezmoi diff`. Apply only when the source diff is correct and
   the user wants the live target updated now.

## Rules

- Treat the chezmoi source directory as the source of truth.
- Prefer native chezmoi patterns over ad hoc symlink or copy schemes.
- If a live target changed outside chezmoi, reconcile it back into source
  instead of patching around the generated copy.
- Temporary runtime experiments are allowed only when the user explicitly asks
  for them; record how to promote the result into source.
- Resolve locations only through `chezmoi source-path` and `chezmoi managed`.
  Do not assume a source-tree path, home-directory layout, or username.

## Scripts

- Status and diff: `chezmoi_status` tool.

## References

- Read `skill://chezmoi-editor/references/conventions.md` when choosing file naming prefixes.
- Read `skill://chezmoi-editor/references/secrets.md` when handling secret values.
