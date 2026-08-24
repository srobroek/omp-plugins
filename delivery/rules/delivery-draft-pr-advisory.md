---
name: delivery-draft-pr-advisory
description: Reminds that agent-authored PRs start as drafts when gh pr create lacks --draft.
condition: ["gh\\s+pr\\s+create(?![^\\n]*--draft)"]
scope: "tool:bash"
interruptMode: never
---

Agent-authored PRs start as drafts (`gh pr create --draft`), per the delivery git
workflow. Promote with `gh pr ready` only after implementation, local validation, and
required agent review are complete and no known blocker remains. Add `--draft` unless
the user explicitly asked for a ready PR.
