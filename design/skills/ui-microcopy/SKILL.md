---
name: ui-microcopy
description: Writes interface copy, error text, empty states, and onboarding wording. Triggers on write the copy for or fix this error message.
---

# UI Microcopy

Phase BUILD. Write the words in the interface, with the same discipline as the pixels.

TRIGGER
+ "write the copy for", "fix this error message", "what should this say"
+ an empty state, error, confirmation, or onboarding step needs wording
- judging copy already shipped -> `ui-review`
- naming a token or component -> `design-system-audit`
- longer-form documentation -> the `write-docs` skill

## Workflow

1. Route to `ux-copy`, which ships vendored inside this package and is therefore always
   available. -> LOAD `skill://ux-copy` and follow it.
2. Take the surface's real constraints from the code before writing: the character budget,
   the states that exist, and the terms the product already uses. -> every proposed string
   fits the space it occupies and reuses the product's existing vocabulary.
3. Verify the copy in place with `skill://ui-review`, at the narrowest supported width. ->
   no truncation, no wrapping that breaks meaning, and the accessible name matches the
   visible text.

## Rules

MUST Name the field and the problem in an error, in text. Colour alone fails WCAG 3.3.1,
  and "something went wrong" names neither.
MUST Give a persistent label, never a placeholder standing in for one. A placeholder
  disappears on focus, which is when the user needs it.
MUST Say what to do next in an empty state. An empty state that only reports emptiness
  wastes the one moment the user is looking for guidance.
MUST Reuse the product's existing term for a concept. A second word for one thing is a
  defect, not a synonym.
DEFAULT Lead with the outcome, not the mechanism. The user cares what happened to their
  work, not which subsystem reported it.
NOT Route to `impeccable clarify` for this. It has no onboarding surface, no structured
  deliverable of recommended copy with tone-tagged alternatives, no requester checklist,
  and no success, error, warning, neutral tone map.
NOT Apologise in an error the user caused, or blame the user for one the product caused.

OUTPUT
L1 COPY: the recommended string per location.
   Alternatives -- tone-tagged options where a choice is genuinely open.
   Constraints -- character budgets and truncation observed in place.
CAP 120w
