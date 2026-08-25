---
name: dep-update-no-scanner-install
description: An absent CVE scanner is reported or run ephemerally, never installed by the audit that found it missing.
condition: ["(?i)\\b(?:pip3?|uv\\s+pip)\\s+install\\b[^\\n]*\\bpip-audit\\b", "(?i)\\bcargo\\s+install\\b[^\\n]*\\bcargo-audit\\b", "(?i)\\bgo\\s+install\\b[^\\n]*\\bgovulncheck\\b", "(?i)\\bnpm\\s+i(?:nstall)?\\b[^\\n]*\\bosv-scanner\\b"]
scope: "tool:bash"
interruptMode: never
---
A missing scanner is a reported coverage gap, not a task. A persistent install
mutates the toolchain to satisfy a read-only audit, and the audit then no longer
describes the machine it ran on.

Sanctioned: an ephemeral runner, which fetches into a cache and leaves no entry
in the environment.

- `uvx pip-audit`
- `npx osv-scanner` · `bunx osv-scanner` · `pnpm dlx osv-scanner`
- `pnpm exec <scanner>` for something the project already depends on
- `go run golang.org/x/vuln/cmd/govulncheck@latest`
- the package manager's own auditor where it ships one: `pnpm audit`,
  `npm audit`, `yarn npm audit`

`command -v <scanner>` decides whether a scanner is already available. Absent and
no runner reaches it: report `scanner not available: <name>` plus its install
hint, and carry the gap into the coverage summary. An unrun scanner never reads
as clean.

Provisioning a scanner permanently is separate work on the user's ask, not a step
inside a dependency audit.
