---
name: delivery-task-scope
alwaysApply: true
---

# Task scope

MUST modify only artifacts required by the current user request or claimed task.

Include a change only when one of these conditions holds:

- The user or acceptance criteria name the behavior.
- The requested implementation requires the change for correctness.
- Preserving the changed contract requires an affected caller or test update.
- The current diff caused the failure.
- A clean cutover requires removal of an obsolete path.
- The repository requires a generated artifact or migration for the requested change.

Scope stays fixed when nearby code is small or easy to improve. The same applies to
pre-existing defects and failures exposed by broad checks. A formatter, linter,
generator, or reviewer does not expand the task.

Tests and prose use the same inclusion test. Update tests when observable behavior
changes. Update prose when it specifies that behavior or the user names it. A broad
check does not justify repairing unrelated tests or documentation.

Target formatters, fix commands, and generators at the narrowest supported paths.
Revert incidental rewrites.

Leave incidental artifacts untouched. When the repository has a ledger, file a
separate unassigned issue with the observed symptom and location. Otherwise report
the issue explicitly. Keep the current task independent from that issue.

Before each edit, ask whether omitting it would make the requested result incorrect
or unverified. If not, do not edit.
