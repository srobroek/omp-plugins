---
name: ui-microcopy
description: Writes and reviews UX copy, including errors, empty states, CTAs, confirmations, and onboarding. Triggers on requests to write copy or fix interface wording.
---
<!--
This skill includes modified guidance from anthropics/knowledge-work-plugins. The
connector-dependent instructions were replaced with local skill references, and the
guidance was merged into this repository's ui-microcopy contract.
-->

# UI Microcopy

Write or review interface copy with the same discipline as the pixels.

TRIGGER
+ "write the copy for", "fix this error message", "what should this say", or "what should this button say"
+ an empty state, error, confirmation, CTA, tooltip, loading state, or onboarding step needs wording
- judging a rendered surface or copy already shipped -> `ui-review`
- naming a token or component -> `design-system-audit`

## Workflow

1. Take the surface's real constraints from code and the running surface: character budget, states, existing terminology, and user context.
2. Load `skill://ui-microcopy/references/copy-guidance.md` for the copy checklist, patterns, voice guidance, and output template.
3. Write the recommended string per location and alternatives only where a choice is open.
4. Verify the copy in place with `skill://ui-review`, at the narrowest supported width -> no truncation, broken wrapping, or accessible-name mismatch.

## Rules

MUST Name the field and the problem in an error. An error shown by colour alone fails WCAG 3.3.1 Error Identification and 1.4.1 Use of Color, and "something went wrong" names neither.
MUST Give every field a persistent label, never a placeholder standing in for one.
MUST Say what to do next in an empty state.
MUST Reuse the product's existing term for a concept.
DEFAULT Lead with the outcome, not the mechanism.
NOT Apologise in an error the user caused, or blame the user for one the product caused.
NOT Route to `impeccable clarify`: it lacks this skill's onboarding surface, structured tone-tagged alternatives, and tone map.

Provenance and the Apache-2.0 obligations this vendored guidance carries: `skill://ui-microcopy/references/upstream.md`.

OUTPUT
L1 COPY: the recommended string per location.
   Alternatives -- tone-tagged options where a choice is open.
   Constraints -- character budgets and truncation observed in place.
CAP 120w
