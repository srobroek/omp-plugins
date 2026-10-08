# whats-new

Research changes between your version and the latest release: additions, deprecations, and breaking changes.

## Skills

| Name | When |
|------|------|
| `whats-new` | "what's new in X", "what changed", "safe to upgrade" |

## Extensions

- `report-only-gate`: arms when a `read` loads `skill://whats-new` or the skill
  body. It blocks `edit`/`write`/`ast_edit` of dependency manifests and lockfiles,
  including hashline `MV` destinations, patch-mode renames and apply_patch headers.
  It also blocks installer/upgrade commands, behind wrappers such as `sudo`, `doas`,
  `env`, `nice`, `timeout` and `stdbuf`, and `dep_apply`.
  Reading `skill://dep-update` releases the research gate, not the host's per-bump approval.

## Tools

The plugin's extension modules register:

- `version_gap_scan`

The scanner reads root language manifests and Python's `uv.lock`/`poetry.lock`.
It does not scan:

- Node lockfiles
- `Cargo.lock`
- `go.sum`
- `Pipfile.lock`
- Ruby/PHP lockfiles
- workspace child manifests

When the scan reports declaration ranges, resolve installed versions separately.
The report-only gate covers direct dependency-file edits and recognized installer commands; it is not a shell sandbox.
