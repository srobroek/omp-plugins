---
name: design-evidence
description: A rendered-UI claim requires named ARIA, computed-style, or screenshot evidence.
alwaysApply: true
---

MUST Cite one of: an ARIA snapshot (`tab.ariaSnapshot()` YAML or `tab.observe()` tree), a computed-style value from `tab.evaluate`, or a screenshot path from `tab.screenshot`, for every claim about a rendered surface.
MUST Name the viewport width (`1440`, `768`, or `375`) on every layout claim.
MUST Re-verify only the assertion that changed after a fix. Unchanged assertions stay cited from the prior pass.
NOT Close VERIFY, CRITIQUE, or RECONCILE with "looks good", "should work", or "appears correct".
NOT Use a screenshot diff as the sole evidence for a claim.
NOT Infer a native-app result from a web snapshot, or the reverse.

| situation | choice |
|---|---|
| claim about roles, names, or focus | ARIA snapshot first |
| claim about color, size, or spacing | computed style |
| claim about appearance only | screenshot path, after the two above |
| layout at a breakpoint | same evidence plus the width |
| fix landed | re-run that one assertion |
