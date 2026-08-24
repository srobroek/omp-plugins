---
name: verify
description: Run and report a final local verification pass. Use when asked to verify, test everything, check readiness, or prove changes safe to hand off.
---

# Verify

## Preferred Flow

1. Prefer project-native quality skills when the change is language-scoped
   (`typescript-quality`, `python-quality`, `go-quality`, `rust-quality`).
2. For a final readiness pass, call `verify_repo`.
3. Report what ran, what was skipped, and what failed.
4. Distinguish environment gaps from real code or test failures.
5. If the repo is polyglot, explain which checks were selected and why.

## Steering

- Do not claim coverage for checks that were skipped or unavailable.
- Keep the report concrete: command, exit code, failure summary.
- Never silently swallow failures -- report every non-zero exit.
- This is a final readiness pass, not a replacement for focused language
  quality skills.
