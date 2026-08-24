---
name: eli5
description: Explain a topic at five depth levels from metaphor to frontier. Use when asked "ELI5", "explain X", "what is X", or "how does X work".
---

# ELI5

Explain the topic from the user request.

## Staging

Before explaining, ask these questions:

1. **Depth**: How deep? All 5 levels (default), or specific levels?
2. **Research**: Pair with research?
   - `read` on a URL / `web_search` -- topic changed materially in the last 12 months or needs current, source-backed facts
   - `whats-new` -- topic is a tool, library, service, or model and you need changes since a baseline
   - none -- explain from existing knowledge (default)

If the user doesn't specify, default to all 5 levels with no research skill.

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
