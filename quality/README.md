# quality

Local verification and mechanical quality gates.

## Skills

| Name | When |
|------|------|
| `verify` | Before handoff, run final local verification |

## Agents

| Name | Role | Model |
|------|------|-------|
| `lint-guard` | Triage lint reports; `LINT-GUARD … PASS\|WARN\|BLOCK` | `@smol` |
| `docs-guard` | Doc-lint gate; `DOCS-GUARD … next=` | `@smol` |
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

Use the built-in `reviewer` for mechanical diff review. Specify the base ref and
changed-file scope. Ask for read-only commands and anchored deterministic
findings, with no heavy test suites or architecture changes.

## Tools

The plugin's extension module registers `verify_repo`.

`verify_repo` reports incomplete verification when no checks run or a detected workflow lacks a prerequisite. Failed discovery or checks return `ok: false`; `complete` distinguishes missing coverage from executed failures.

Before verification, install JavaScript executables; the tool never downloads them.
