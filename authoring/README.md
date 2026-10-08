# authoring

Author and audit agentic assets (skills, rules, agents).

## Skills

| Name | When |
|------|------|
| `write-agentic` | Create or rewrite a skill, steering/rule, or agent from the templates; audit steering |

## Rules

| Name | When |
|------|------|
| `authoring-extension-ctx-timers` | Raw `setTimeout`/`setInterval` in an extension module (TTSR) |
| `authoring-omp-steering-precedence` | Which guidance layer wins when instructions conflict (always applied) |

## Extensions

- `agentic-auto-lint`: after a `write`, `edit`, or `ast_edit` lands on a
  `SKILL.md`, `rules/*.md`, `agents/*.md`, `AGENTS.md`, or `RULES.md` file, runs the
  `agentic_lint` checks on it and prepends its ERROR findings; silent when it has none.
  An unchanged report is not repeated. It skips vendored trees, `docs/rules/`, and
  the OMP plugin cache and marketplace copies under `~/.omp`.

## Tools

Registered by this plugin's extension modules:

- `agentic_lint`

Repository CI runs `bun scripts/check-agentic-metadata.ts` over Markdown files in each top-level plugin's `rules/` and `agents/` directory, plus each skill directory's `SKILL.md`. It reports counts for those asset kinds and fails on malformed frontmatter or the validator's E13/E14 metadata errors. For agents, this gate also requires nonempty `model`, `thinking-level`, and comma-separated `tools` metadata.
The metadata gate does not run the full `agentic_lint` checks: prose-style findings and other lint codes remain outside this CI step.
