---
name: shell-language
description: When writing or reviewing shell portability, command safety, quoting, or testing.
---

# Shell

Quote expansions unless intentional splitting is required. Prefer arrays for
commands and arguments when the selected shell supports them.

Keep scripts compatible with their declared interpreter. Do not use Bash-only
features in POSIX `sh` scripts, and account for macOS Bash 3.2 when portability
is required.

Run `shellcheck` and syntax checks for the declared interpreter. Treat command
construction, temporary files, and destructive operations as explicit trust
boundaries.
