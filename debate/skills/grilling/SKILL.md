---
name: grilling
description: Interviews the user relentlessly about a plan or decision in numbered frontier rounds. Triggers on grill me or stress-test my thinking.
---

<!--
Vendored from mattpocock/skills 1.2.3, path skills/productivity/grilling/SKILL.md, copied
2026-10-08. Licensed under the MIT License, Copyright (c) 2026 Matt Pocock. The full
licence text is in the LICENSE file beside this one.

THIS FILE HAS BEEN MODIFIED from the original. Changes:
  1. Fact lookups: upstream dispatched a sub-agent for every fact from the environment.
     Cheap lookups (a few reads, one grep) now run inline; a sub-agent is reserved for
     wide exploration.
  2. Rewrote the frontmatter description to this repository's authoring contract.
The design-tree framing, the frontier rounds, the round format, and the completion
condition are upstream's and are unchanged in substance.
-->

# Grilling

TRIGGER
+ "grill me", "stress-test my thinking", "poke holes in this plan"
+ a decision with several dependent sub-decisions that the user wants settled one by one
- a two-sided analysis of one decision → `skill://debate`
- a questionnaire for someone other than the user → `skill://to-questionnaire`

Interview the user relentlessly until you reach a shared understanding. Map this as a
**design tree**: every decision branches into the decisions that hang off it.

## Workflow

1. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are
   already settled: the questions you can ask now without guessing at answers you have
   not heard yet. Ask the whole frontier in one round: number each question and give
   your recommended answer. Then wait for the user's answers before the next round.
2. Format a round like so:

   ```
   **Q1** - **Question title**: question body, which may run to several paragraphs and
   list several choices
   > your recommended answer

   **Q2** - **Question title**: question body
   > your recommended answer
   ```

3. Each round reshapes the tree: settled decisions push the frontier outward and unblock
   the questions that depended on them. Recompute the frontier and ask the next round. A
   question whose answer depends on another question still open in this round belongs to
   a later round.
4. Finding facts is your job, never the user's. Look a fact up inline when a few reads or
   one grep answer it. Dispatch a sub-agent only for wide exploration, and do not block on
   it: only the questions downstream of that fact wait; ask the rest of the frontier now.
5. Decisions are the user's: put each to them and wait.

## Rules

MUST End the session only when the frontier is empty: every branch of the design tree
  visited, nothing left silently assumed.
NOT Act on the plan before the user confirms that you share an understanding.
NOT Ask the user for a fact a read, grep, or sub-agent can find.
