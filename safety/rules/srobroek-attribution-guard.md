---
name: srobroek-attribution-guard
description: Blocks AI-assistant attribution in a git commit message supplied with -m/--message or a -F/--file message file.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?:(?:d?git)\\s+)?commit\\b[^\\n;&|]*(?:--message(?:=|\\s+)|-m\\s+)(?:\"[^\"\\n;&|]*(?:co-authored-by:[^\\n]{0,120}(?:claude|codex|gpt|copilot|cursor|devin|anthropic|openai)|generated with [\\[(]?(?:claude|codex|copilot)|noreply@(?:anthropic|openai)\\.com)[^\"\\n;&|]*\"|'[^'\\n;&|]*(?:co-authored-by:[^\\n]{0,120}(?:claude|codex|gpt|copilot|cursor|devin|anthropic|openai)|generated with [\\[(]?(?:claude|codex|copilot)|noreply@(?:anthropic|openai)\\.com)[^'\\n;&|]*')", "(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)[^\\n;&|]*(?:co-authored-by:[^\\n]{0,120}(?:claude|codex|gpt|copilot|cursor|devin|anthropic|openai)|generated with [\\[(]?(?:claude|codex|copilot)|noreply@(?:anthropic|openai)\\.com)[^\\n;&|]*>\\s*(\\S+)[^\\n;&|]*(?:&&|;|\\|)\\s*(?:d?git)\\s+commit\\b[^\\n;&|]*\\s(?:-F|--file)\\s+\\1(?:[\\s;&|]|$)"]
scope: "tool:bash"
interruptMode: always
---

This commit message carries AI-assistant attribution. Rewrite the `-m`/`--message` text, or rewrite the file supplied to `-F`/`--file`, so the commit names only the human author.
