# quality

Code-smell audits, local verification, and mechanical quality gates.

## Skills

| Name | When |
|------|------|
| `sniff` | Audit code for smells, map them to catalogued refactorings, and produce a vetted plan |
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
| `quality-browser-verification` | Browser-visible UI changes |
| `quality-sniff-analyzer-redirect` | Marked direct analyzer command during an active sniff run (TTSR advisory) |

## Tools

Registered by this plugin's extension modules:

- `sniff_install_tools`
- `sniff_run_analyzer`
- `verify_repo`
