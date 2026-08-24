---
name: srobroek-attribution-guard
description: Blocks git commits carrying AI-assistant attribution trailers, generated-with lines, or agent noreply addresses.
condition: ["(?i)(co-authored-by:[^\\n]{0,120}(claude|codex|gpt|copilot|cursor|devin|anthropic|openai)|generated with [\\[(]?(claude|codex|copilot)|noreply@(anthropic|openai)\\.com)"]
scope: "tool:bash"
interruptMode: always
---

This commit carries AI-assistant attribution: a `Co-Authored-By` trailer naming an agent vendor, a
"generated with" line, or an agent noreply address.

Commits in this estate are attributed to the human author only. `includeCoAuthoredBy` is already
`false` and the `attribution.commit` / `attribution.pr` templates are deliberately empty; this rule
covers the remaining path, where a commit message is composed by hand inside a shell command.

Rewrite the message without the attribution trailer and re-issue.

The pattern is scoped to authorship-shaped constructs on purpose. An ordinary commit message that
merely mentions a model name — for example "fix AI model loading bug" — does not match, and must not
be reworded on account of this rule.
