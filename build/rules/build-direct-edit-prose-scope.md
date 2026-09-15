---
name: build-direct-edit-prose-scope
alwaysApply: true
---

When directly modifying code, change prose only when it directly explains or specifies the code being modified.

This applies to comments, docstrings, READMEs and other documentation, examples, changelogs, and agentic prose touched alongside code. Related prose includes text that states the modified code's behavior, API contract, invariant, error, or usage; update it when the code change makes it stale.

NEVER clean up, reformat, rewrite, or correct unrelated prose in the same file or elsewhere. An explicit user request to edit that prose makes it in scope.

For the automatic Slopvac documentation/comment pass only: in upstream or otherwise uncontrolled repositories, lint and fix only added or modified hunks; never fix findings in untouched passages. In first-party or controlled documents, whole-document Slopvac lint and fix is permitted, including findings outside the edited passages. Ordinary manual/direct edits and all upstream documentation or comments remain related and hunk-scoped.