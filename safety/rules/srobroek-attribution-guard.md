---
name: srobroek-attribution-guard
description: Blocks git commits carrying AI-assistant attribution trailers, generated-with lines, or agent noreply addresses.
condition:
  - "(?i)\\b(?:d?git)\\b[^\\n]{0,80}\\bcommit\\b[\\s\\S]{0,600}?(?:co-authored-by:[^\\n]{0,120}(?:claude|codex|gpt|copilot|cursor|devin|anthropic|openai)|generated with [\\[(]?(?:claude|codex|copilot)|noreply@(?:anthropic|openai)\\.com)"
  - "(?i)(?:co-authored-by:[^\\n]{0,120}(?:claude|codex|gpt|copilot|cursor|devin|anthropic|openai)|generated with [\\[(]?(?:claude|codex|copilot)|noreply@(?:anthropic|openai)\\.com)[\\s\\S]{0,600}?\\b(?:d?git)\\b[^\\n]{0,80}\\bcommit\\b"
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

It is also scoped to commit-shaped context: the attribution has to sit within 600
characters of a `git`/`dgit` commit in the same command, in either order, because
the message may be composed in a heredoc before `git commit -F` as readily as
inside `-m`. Attribution alone is not a commit — `echo generated with claude`,
`rg 'noreply@anthropic.com'`, and `git log -p | rg -i 'co-authored-by: claude'`
all pass, and the first of those blocked a live session under the older pattern.
What remains matched by proximity is a grep for the trailer chained onto an
unrelated commit in one call; separating that needs the commit message, which the
token stream does not have.
