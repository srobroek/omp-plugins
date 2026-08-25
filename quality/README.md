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
| `bloodhound` | Read-only per-language smell detector (spawned by sniff) | `@slow` |
| `refactor-challenger` | Adversarial critic of sniff findings | `@challenger` |
| `lint-guard` | Triage lint reports; `LINT-GUARD … PASS\|WARN\|BLOCK` | `@smol` |
| `docs-guard` | Doc-lint gate; `DOCS-GUARD … next=` | `@smol` |
| `reviewer-mechanics` | Diff smoke; `MECH-REVIEW … verdict=PASS\|CHANGES` | `@fast-coder` |
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

## Rules

| Name | When |
|------|------|
| `quality-browser-verification` | Browser-visible layout/interaction/rendering/state changes |

## Tools

Registered by this plugin's extension modules:

- `sniff_install_tools`
- `verify_repo`
