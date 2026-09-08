---
name: eli5
description: Explain a topic at five depth levels from metaphor to frontier. Use when asked "ELI5", "explain X", "what is X", or "how does X work".
---

# ELI5

Explain the topic from the user request.

## Staging

Explain immediately when the topic is clear. Honor the requested depth and length;
a simple “ELI5” starts with a concise metaphor and plain-language explanation.
Use all five levels when requested, or offer deeper levels after a short answer.
Ask only when an ambiguous topic prevents a useful answer.

Research current or source-sensitive claims with `read` or `web_search`.
Use `whats-new` for changes since a specified baseline. Stable concepts need no
research ceremony or delegation.

## Depth levels

| Level | Name | Goal | Words |
|-------|------|------|-------|
| 1 | **Metaphor** | What it's like. Pure analogy, zero jargon. A child could follow. | ~80-120 |
| 2 | **Concept** | What it is. Plain language, core ideas, when you'd reach for it. | ~80-120 |
| 3 | **Mechanism** | How it works. Technical detail, components, data flow, key algorithms. | ~80-120 |
| 4 | **Tradeoffs** | Why it matters. Design choices, alternatives, when to use vs. avoid, failure modes, cost. | ~80-120 |
| 5 | **Frontier** | What's next. Edge cases, open problems, competing research, where the field is heading. | ~150 |

## Output format

Each level gets its own heading with a one-line summary:

```
## 1. Metaphor
The shortest version: It's like sending a sealed envelope through a chain of trusted couriers.

[3-5 short paragraphs]
```

Repeat for each requested level.

## Rules

- Prefer accuracy over cute analogies.
- Do not flatten meaningful uncertainty just to simplify.
- If the user asks for one level only, give one level only.
- Make higher levels add nuance, not just length.
- Word budgets are soft targets -- adjust for topic complexity; accuracy always wins over budget.
