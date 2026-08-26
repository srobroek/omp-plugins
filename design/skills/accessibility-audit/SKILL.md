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

1. Route by job, in this order. -> the chosen route is named in the report header.
   - PRIMARY measurement, any web surface: the `accessibility-scanner` MCP server, which
     this package already declares. It runs the axe-core WCAG 2.2 engine IN-PROCESS, so
     there is no ChromeDriver anywhere in the path and therefore no version-skew failure
     mode. It scrolls before scanning so lazy content is covered, resolves contrast over
     gradients, and returns a selector, a criterion, and a fix link.
   - web surface, for the criteria coverage and the audit's substance: upstream skill
     `accessibility`.
   - native surface: the matching `ehmo` platform skill via `skill://platform-conformance`,
     which carries each platform's own accessibility guidance.
   - FALLBACK, and only for a multi-URL CI gate:
     `npx --yes --package=@axe-core/cli axe "<url>" --stdout --exit`. It accepts more than one
     quoted URL, JSON node targets, `--include` and `--exclude`, and exits non-zero,
     which the MCP scanner cannot do because it takes one page. Two caveats bind it:
     it drives a real Chrome through ChromeDriver, so run
     `npx --yes browser-driver-manager install chrome`, then `eval "$(npx --yes
     browser-driver-manager which)"`, and pass `--chrome-path "$CHROME_TEST_PATH"` with
     `--chromedriver-path "$CHROMEDRIVER_TEST_PATH"`. Installing alone is not enough: it
     downloads the pair and puts neither on axe's path. Measured without them, it exits 2 on
     "This version of
     ChromeDriver only supports Chrome version 152. Current browser version is
     151.0.7922.174", having tested nothing at all.
     And because that environment failure also exits non-zero, a non-zero exit does NOT by
     itself mean an accessibility violation. Read the JSON and judge the findings; the exit
     code alone distinguishes nothing.
     Quote every substituted URL: a query string carries `&` and `?`, which an unquoted
     argument hands to the shell. The bin is `axe`, not the package name, so pass `--package`.
2. Check the routed skill name is in your available skills BEFORE loading it. Reading a
   `skill://` path that does not exist throws `Unknown skill`. -> present: LOAD and follow.
   Absent: do NOT improvise. A thin substitute audit is worse than none, because its verdict
   reads exactly like the real one. Report the gap, name the install command from
   `skill://accessibility-audit/references/upstream.md`, and ASK the user to run it. An
   install applies from the NEXT session, since OMP discovers plugins at startup, so never
   install and retry within this one. The `accessibility-scanner` MCP server above needs no
   install and, when connected, is the primary measurement route, so measurement continues
   while an install is pending. The upstream's criteria coverage does not: do not improvise it.
   Bound that continuation: both no-install routes are WEB-ONLY and cover only a runnable
   URL. Neither substitutes for source review, for a manual keyboard walkthrough, or for
   native-platform guidance. On a NATIVE surface with the `ehmo` skill absent, nothing
   substitutes: STOP, report, and ask.
3. Measure on the live surface with `skill://ui-review`: `tab.ariaSnapshot()` for roles and
   accessible names, `tab.evaluate` for computed colors and target boxes, `tab.press` for
   focus order and traps. -> every finding carries a measured value and a required value.

## Rules

MUST Report the measured value AND the required value on every finding.
MUST Give both color values and the computed ratio on a contrast finding. A contrast claim
  missing any of the three is not reported at all.
MUST Trust the rendered accessible name over the name inferred from markup.
MUST Report a criterion you could not exercise as untested, naming the blocker.
MUST Read the axe CLI's JSON before calling a non-zero exit a violation. An environment
  failure exits non-zero too: measured, a ChromeDriver and Chrome mismatch exits 2 having
  tested nothing, which reads exactly like a failing gate.
DEFAULT Collapse one root cause across many elements into one finding with a count.
NOT Pass a surface on markup alone, or cite a criterion number you did not test.
NOT Use the axe CLI for interactive investigation, or the MCP scanner as an exit gate.

OUTPUT
L1 VERDICT: PASS | MINOR | MAJOR -- route used, one sentence why.
   Findings -- criterion number, location, measured value, required value, fix.
   Untested -- criteria not exercised, with the blocker.
CAP 120w clean · 280w with findings
