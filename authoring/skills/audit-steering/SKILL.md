---
name: audit-steering
description: Audit and optimize agent-facing markdown for drift, duplication, and token waste. Use when asked to audit steering, review agent config, or optimize skills.
---

# Steering Audit & Optimize

Audit agent configuration surfaces for issues, then apply R1-R7 rewrites to fix them.

## Phase 1 -- Audit (find issues)

1. **Lint scan**: Run `agnix --show-fixes` on config directories. Categorize findings as real errors, false positives, or auto-fixable.
2. **Hook efficiency**: Count hooks per event type. Flag unconditional Bash hooks, duplicate references, prompt-type hooks doing pure string checks.
3. **Duplication scan**: Cross-reference CLAUDE.md, rules, hooks, and skills. Flag policies stated in 2+ places, and rules that hooks enforce mechanically.
4. **Stale file detection**: Empty rule files, unreferenced agent files, outdated memory entries, empty directories.
5. **Token budget**: Identify always-loaded rules without glob scoping. Flag files exceeding 5KB. Suggest lazy-loading candidates.
6. **Bootstrap leakage**: Global/bootstrap skills that are present as project-local copies when they should remain global.
7. **AGENTS.md minimality**: Root `AGENTS.md` should stay minimal when APM owns detail; scoped `AGENTS.md` files should be path-specific.
8. **Claude rules scope**: Claude rules should not duplicate large global content.

## Phase 2 -- Optimize (fix issues)

Apply R1-R7 rewrites to files flagged in Phase 1. LOAD `skill://audit-steering/references/rules.md` for the exact checks.

| Rule | What |
|------|------|
| R1 | `description` in YAML frontmatter on every file |
| R2 | Imperative tone, no model names, frame as actions |
| R3 | Tables for mappings, bullets for rules |
| R4 | `write-agentic`'s templates + `lint.py` own the per-kind format contract |
| R5 | Relative paths for files, backticks for skill/agent names |
| R6 | `lint.py`'s per-kind line caps; split oversized files |
| R7 | Index files as routing tables, detail in referenced files |

Measure before and after: LOAD `skill://audit-steering/references/measurement.md` for token estimation and report format.

## Output Format

- Summary line: X errors, Y warnings, Z suggestions
- Section per check with findings (file, severity, description, fix)
- Priority actions sorted by impact
- No prose filler

## Steering

- Prefer enforceable automation for mechanical policy.
- Prefer short guidance for judgment-heavy policy.
- Focus findings on real drift, not stylistic preferences.

## References

| File | When to load |
|------|--------------|
| `skill://audit-steering/references/checklist.md` | Phase 1: full audit pass |
| `skill://audit-steering/references/rules.md` | Phase 2: R1-R7 checks |
| `skill://audit-steering/references/measurement.md` | Phase 2: token estimation and report format |
