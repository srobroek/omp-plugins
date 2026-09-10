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
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

Use the built-in `reviewer` for mechanical diff review. Specify the base ref and
changed-file scope. Ask for read-only commands and anchored deterministic
findings, with no heavy test suites or architecture changes.

## Rules

| Name | When |
|------|------|
| `quality-browser-verification` | Browser-visible UI changes |
| `quality-sniff-analyzer-redirect` | Marked direct analyzer command during an active sniff run (TTSR advisory) |

## Tools

The plugin's extension modules register:

- `sniff_install_tools`
- `sniff_run_analyzer`
- `verify_repo`

`verify_repo` reports incomplete verification when no checks run or a detected workflow lacks a prerequisite. Failed discovery or checks return `ok: false`; `complete` distinguishes missing coverage from executed failures.

Before verification, install JavaScript executables; the tool never downloads them.

`sniff_install_tools` reports unsuccessful installation when a command fails or a requested tool has no supported installer. Probe and list report inventory, not verification success.
