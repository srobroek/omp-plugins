---
name: debate
description: Use when stress-testing an architectural decision, technology choice, or feature proposal from both sides before committing.
---

# Debate

Analyze and debate the topic from the user request.

Answer an already-specified request directly. Ask only for missing context that changes the decision; use `grill-me` when installed and a deeper interview is warranted.

## Process

### Phase 0: Context questions

Infer decision type and scope from the request and available evidence. Ask about
unresolved constraints only. Research when requested or when current facts are
material; do not require the user to choose an agent strategy.

### Phase 1: Decomposition

Choose only the investigation angles material to the request: user need, simpler alternatives, reversibility, implementation or operational cost.

### Phase 2: Research (conditional)

Research inline for bounded questions. For multiple independent investigations
that warrant delegation, launch one parallel batch with a scoped brief per angle.
Codebase-aware work uses repository evidence; isolated analysis does not import
local project assumptions. If delegation is unavailable, research inline and
disclose the lack of an independent reader.

### Phase 3: Main analysis

Synthesize into structured sections:
- **Problem Validation** -- is the problem real and worth solving?
- **Pros** -- with evidence strength (strong / moderate / weak)
- **Cons** -- with severity (blocker / major / minor)
- **Tradeoffs** -- what you gain vs. what you give up
- **Alternatives** -- "Do nothing" is always first; "Simplest viable approach" is always second
- **Overengineering Assessment** -- answer these 5 questions:
  1. Would doing nothing solve the problem adequately?
  2. What is the simplest thing that could possibly work?
  3. Which part of this solution is solving a problem we don't have yet?
  4. If we had to ship this in 48 hours, what would we cut?
  5. How hard is this to undo if we're wrong?
- **Reversibility** -- one-way door, two-way door, or reversible with cost

### Phase 4: Devil's advocate

For a simple request, present the strongest counterargument directly.
For consequential or contested decisions, obtain an independent critique when
an appropriate agent is available, briefed with the finished Phase 3 analysis:
challenge the strongest pro, identify unstated assumptions, and name the
strongest argument against the proposal. Otherwise run a separate critique pass
and label it self-review, not independent evidence.

### Phase 5: Synthesis

Merge the main analysis with the devil's advocate critique:
- Incorporate valid criticisms; note deflected ones with reasoning
- Calibrate confidence: High (75-95%), Medium (40-74%), Low (10-39%)
- Produce a conditional verdict: "This makes sense IF... It does NOT make sense IF..."

Offer additional rounds only when an unresolved tradeoff warrants discussion.

### Phase 6: Save

Save to `research/debate-<slug>.md` only when the user requests a file; otherwise return the report in chat.


## Rules

- YAGNI is the default stance. Burden of proof is on complexity.
- "Do nothing" is mandatory and must be taken seriously.
- An independent critique receives the finished analysis, not raw research.
- Verdict is ALWAYS conditional, never binary.
- Overengineering assessment must be substantive, not perfunctory.
