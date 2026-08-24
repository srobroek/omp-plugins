# quality

Smell audit, local verification, mechanical quality gates, and browser-verification discipline.

## Skills

| Name | When |
|------|------|
| `sniff` | Audit code for smells, map to refactoring.guru, produce a vetted refactoring plan |
| `verify` | Final local verification pass before handoff |

## Agents

| Name | Role | Model |
|------|------|-------|
| `bloodhound` | Read-only per-language smell detector (spawned by sniff) | `@architect` |
| `refactor-challenger` | Adversarial critic of sniff findings | `@challenger` |
| `lint-guard` | Triage lint reports; `LINT-GUARD … PASS\|WARN\|BLOCK` | `@smol` |
| `docs-guard` | Doc-lint gate; `DOCS-GUARD … next=` | `@smol` |
| `reviewer-mechanics` | Diff smoke; `MECH-REVIEW … verdict=PASS\|CHANGES` | `@fast-coder` |

## Rules

| Name | When |
|------|------|
| `quality-index` | Always-apply index |
| `quality-browser-verification` | Browser-visible layout/interaction/rendering/state changes |
