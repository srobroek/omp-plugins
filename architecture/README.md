# architecture

Capability-first layout, ownership boundaries, durable project knowledge under `docs/`, and a read-only `architect` agent.

## Rules

| Name | When |
| --- | --- |
| `architecture-top-level` | Choosing repository top-level directories |
| `architecture-ownership` | libs roles, contracts, schemas, product agents, UI primitives, and data assets |
| `architecture-docs-files` | Durable project knowledge under `docs/` |

## Agents

| Name | Role | Model |
| --- | --- | --- |
| `architect` | Read-only software, system, module, and API design; complex implementation plans | `@plan` |

## Works with quality

`architect` loads `skill://quality-code-design/references/release.md` for cutover transitions, and `architecture-docs-files` points to `skill://quality-code-design/references/lifecycle.md` for decision records. Install `quality` too; without it the agent reports the missing guidance.
