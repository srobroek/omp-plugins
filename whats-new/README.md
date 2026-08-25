# whats-new

Research breaking changes, deprecations, and new features between the version in use and latest.

## Skills

| Name | When |
|------|------|
| `whats-new` | "what's new in X", "what changed", "safe to upgrade" |

## Extensions

- `report-only-gate` — arms when a `read` loads `skill://whats-new` or the skill
  body, then blocks `edit`/`write` of dependency manifests and lockfiles and
  blocks installer/upgrade commands for the rest of the session. Reading
  `skill://dep-update` releases it: dep-update owns real upgrades.

## Rules

| Name | When |
|------|------|

## Agents

None.

## Tools

Registered by this plugin's extension modules:

- `version_gap_scan`
