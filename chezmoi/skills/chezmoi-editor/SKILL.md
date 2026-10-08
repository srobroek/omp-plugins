---
name: chezmoi-editor
description: Edits chezmoi-managed dotfiles at their authoritative source. Use when changing dotfiles, templates, symlinks, private files, or global agent and tool configuration.
---

# Chezmoi Editor

Use this skill when a task changes files managed by chezmoi. Resolve the managed
source first; do not edit the rendered live target as the durable fix.
The `chezmoi-guard` extension refuses `edit`/`write`/`ast_edit` writes to a
managed target and common literal bash writes (`>`/`>>` redirects, `tee`,
`cp`/`mv`, `sed -i`, `perl -i`), and names the source path to edit. It reads
literal words only: writes through `sh -c`, `eval`, scripts, variables other than
`$HOME`, or other tools pass unchecked, so resolve the source yourself.

## Workflow

1. Determine whether the target is managed:
   - `chezmoi managed`
   - `chezmoi source-path <target>` when a specific target is known
   - existing symlink/source layout when chezmoi cannot resolve it directly
2. Edit the source under the chezmoi source tree, not `$HOME` runtime output.
3. Use native chezmoi names for dotfiles, executables, private files, readonly
   files, symlinks, scripts, and templates.
4. Never write a credential in plaintext. Read it at apply time with
   `{{ onepasswordRead "op://<vault>/<item>/<field>" }}` in a `.tmpl` file, or
   store the file with `chezmoi add --encrypt <target>`. `private_` only sets
   `0600` permissions; the file stays plaintext in git.
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

- Status and diff: `chezmoi status`, `chezmoi diff`.

## References

- Read `skill://chezmoi-editor/references/conventions.md` when choosing file naming prefixes.
