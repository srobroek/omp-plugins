---
name: dep-update-no-scanner-install
description: Advisory after a bash call that installs a CVE scanner persistently during a dependency audit; prefer an ephemeral runner or report the gap.
condition: ["\"command\"\\s*:\\s*\"(?:(?:[^\"'\\\\]|\\\\[^\"]|'[^']*'|\\\\\"(?:[^\"\\\\]|\\\\[^\"])*\\\\\")*?(?:(?:[;&|(]|\\\\n)\\s*|\\b(?:then|do)\\s+))?(?:sudo\\s+)?(?:(?:python[\\d.]*\\s+-m\\s+)?pip[\\d.]*\\s+install|pipx\\s+install|uv\\s+tool\\s+install|brew\\s+install|(?:npm|pnpm|bun)\\s+(?:i|install|add)(?=(?:[^\"\\\\;&|]|\\\\[^n])*?\\s(?:-g|--global)(?![\\w-]))|yarn\\s+global\\s+add|cargo\\s+b?install|go\\s+install)\\b(?:[^\"\\\\;&|]|\\\\[^n])*?(?<![\\w.-])(?:pip-audit|osv-scanner|cargo-audit|govulncheck)(?![\\w.-])"]
scope: "tool:bash"
interruptMode: never
---
This reminder arrives after the command was sent; it does not stop it. If a
persistent scanner install just ran inside a dependency audit, say so in the
report: the audit no longer describes the machine as it was.

A missing scanner is a reported coverage gap, not a task. A persistent install
(`pip install`, `python -m pip install`, `pipx install`, `uv tool install`,
`brew install`, `npm install --global`, `cargo install`/`cargo binstall`,
`go install …@<any version>`) mutates the toolchain to satisfy a read-only audit.

Sanctioned: an ephemeral runner, which fetches into a cache and leaves no entry
on PATH.

- `uvx pip-audit`
- `go run golang.org/x/vuln/cmd/govulncheck@latest`
- `go run github.com/google/osv-scanner/v2/cmd/osv-scanner@latest` (osv-scanner is not published to npm)
- `pnpm exec <scanner>` / `npx <scanner>` for a scanner the project already depends on
- the package manager's own auditor where it ships one: `pnpm audit`,
  `npm audit`, `yarn npm audit`

`cargo-audit` has no ephemeral runner: use it when `command -v cargo-audit`
finds it, otherwise report the gap.

`command -v <scanner>` decides whether a scanner is already available. Absent and
no runner reaches it: report `scanner not available: <name>` plus its install
hint, and carry the gap into the coverage summary. An unrun scanner never reads
as clean.

Provisioning a scanner permanently is separate work on the user's ask, not a step
inside a dependency audit.
