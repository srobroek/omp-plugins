---
name: accessibility-audit
description: Audits a surface against WCAG 2.2 AA with measured values. Triggers on is this accessible or check accessibility or WCAG.
---

# Accessibility Audit

Phase CRITIQUE. Measure against WCAG 2.2 level AA and report values, not opinions.

TRIGGER
+ "is this accessible", "check accessibility", "WCAG", "screen reader"
+ any landed change to a rendered surface, before reporting it done
- general visual or UX quality -> `ui-review`
- vendor platform conventions -> `platform-conformance`
- error and empty-state wording -> `ui-microcopy`

## Workflow

1. Route by target, in this order. -> the chosen route is named in the report header.
   - web surface: upstream skill `accessibility`. The winner.
   - native surface: the matching `ehmo` platform skill via `skill://platform-conformance`,
     which carries each platform's own accessibility guidance.
   - interactive single-page investigation: the `accessibility-scanner` MCP server. It runs
     the axe-core WCAG 2.2 engine, scrolls before scanning so lazy content is covered,
     resolves contrast over gradients, and returns a selector, a criterion, and a fix link.
   - explicit-URL CI gate: `npx --yes --package=@axe-core/cli axe <urls> --stdout --exit`.
     The bin is `axe`, not the package name, so pass `--package`. It takes multiple URLs,
     JSON node targets, `--include` and `--exclude`, and exits non-zero. The MCP scanner is
     single-page and cannot be a process-exit gate.
2. Check the routed skill name is in your available skills BEFORE loading it. Reading a
   `skill://` path that does not exist throws `Unknown skill`. -> present: LOAD and follow.
   Absent: STOP, emit the install command from
   `skill://accessibility-audit/references/upstream.md`, and run it. A thin substitute
   audit is worse than none, because its verdict reads exactly like the real one.
3. Measure on the live surface with `skill://ui-review`: `tab.ariaSnapshot()` for roles and
   accessible names, `tab.evaluate` for computed colors and target boxes, `tab.press` for
   focus order and traps. -> every finding carries a measured value and a required value.

## Rules

MUST Report the measured value AND the required value on every finding.
MUST Give both color values and the computed ratio on a contrast finding. A contrast claim
  missing any of the three is not reported at all.
MUST Trust the rendered accessible name over the name inferred from markup.
MUST Report a criterion you could not exercise as untested, naming the blocker.
DEFAULT Collapse one root cause across many elements into one finding with a count.
NOT Pass a surface on markup alone, or cite a criterion number you did not test.
NOT Use the axe CLI for interactive investigation, or the MCP scanner as an exit gate.

OUTPUT
L1 VERDICT: PASS | MINOR | MAJOR -- route used, one sentence why.
   Findings -- criterion number, location, measured value, required value, fix.
   Untested -- criteria not exercised, with the blocker.
CAP 120w clean · 280w with findings
