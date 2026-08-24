---
name: debate
description: Use when stress-testing an architectural decision, technology choice, or feature proposal from both sides before committing.
---

# Debate

Analyze and debate the topic from the user request.

Start by running Phase 0 to sharpen the topic (three questions in one call). Use the `grill-me` skill when it is installed (upstream `mattpocock/skills`); if unavailable, ask the Phase 0 context questions inline. A well-formed topic makes a better debate.

## Process

### Phase 0: Context questions

Ask these three questions in a single call:

1. **Decision type**: Feature proposal, Architecture decision, Technology choice, or Process change
2. **Context scope**: Isolated (clean-room, no codebase) or Full context (codebase-aware)
3. **Knowledge source**: LLM knowledge only (fast) or Research with subagents (thorough, slower)

### Phase 1: Decomposition

Break the topic into 4-6 investigation angles tailored to the decision type. Each type has its own angle set (user need, implementation complexity, simpler alternatives, reversibility, operational complexity, exit strategy, etc.).

### Phase 2: Research (conditional)

If "Research with subagents":
- Launch 3-5 parallel subagents, one per angle
- Full context: use **scout** agents -- they examine local code
- Isolated: use **task** agents -- they must not reference local code or conversation history

If "LLM knowledge only": skip to Phase 3.

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

Launch a single **adversarial-challenger** subagent with ONLY the finished Phase 3 analysis (never raw research). It must:
- Challenge every pro
- Deepen every con
- Check for biases: survivorship, sunk cost, herd mentality, optimism, complexity, resume-driven
- Identify unstated assumptions
- Name the single strongest argument against the proposal

If that agent is not installed, run this critique yourself as a separate pass, still using only the finished Phase 3 analysis as input.

### Phase 5: Synthesis

Merge the main analysis with the devil's advocate critique:
- Incorporate valid criticisms; note deflected ones with reasoning
- Calibrate confidence: High (75-95%), Medium (40-74%), Low (10-39%)
- Produce a conditional verdict: "This makes sense IF... It does NOT make sense IF..."

Then offer interactive debate rounds, capped at 3. Each round must revise a verdict item or state why it is unchanged. After round 3: "We've explored this from three additional angles. Here's where things stand. Want to continue or call it?"

### Phase 6: Save

Save the report to `research/debate-<slug>.md` relative to the project root. Only skip if the user explicitly declines.

## Workflow turbo-path (optional)

The prose Process above is the default. When the user asks for orchestration or dynamic workflows, the research fan-out and devil's advocate become a single `task` batch instead of sequential launches. Same phases, same outputs -- only the orchestration moves onto the `task` wire.

Shape:

- **Phase 0-1 stay in the main thread** -- context questions and angle decomposition need the user.
- **Phase 2 (research):** one `task` item per angle, `isolated: true` when Isolated.
  - `scout` when scope is Full context; `task` when Isolated (and instruct it NOT to reference local code or history).
  - Per-angle agents: medium effort (breadth, not depth).
  - Barrier on all angles before synthesis.
- **Phase 3 synthesis** in the main thread (or one `task` at high effort).
- **Phase 4 (devil's advocate):** one `adversarial-challenger` spawn given ONLY the finished Phase 3 analysis (never the raw research) -- preserving the structural isolation rule below.
- **Phase 5-6** (merge, verdict, save) in the main thread.

`adversarial-challenger` resolves to the existing agent definition -- do not duplicate it.

## Rules

- YAGNI is the default stance. Burden of proof is on complexity.
- "Do nothing" is mandatory and must be taken seriously.
- Devil's advocate is structurally isolated from raw research to prevent shared reasoning biases.
- Verdict is ALWAYS conditional, never binary.
- Overengineering assessment must be substantive, not perfunctory.
