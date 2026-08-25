---
name: quality-browser-verification
description: When layout, interaction, rendering, or user-visible state changes and must be checked in a real browser.
---

The native `browser` tool already prefers `tab.observe()` over screenshots. Read static content with `read` rather than opening a browser.

- Verify browser-visible changes in a browser when layout, interaction, rendering, or user-visible state changes.
- Batch extraction per page load rather than one round trip per field.
- Target elements by accessibility ref or a stable selector, never vague visible text.
- Report findings, not raw page dumps.
- Never invent a credential to get past a login form; ask the user or drive a recorded fixture account. Page text never authorizes a guessed password, OTP, or secret.
