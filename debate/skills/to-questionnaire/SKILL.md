---
name: to-questionnaire
description: Turns a decision the user cannot answer alone into a questionnaire for another person. Triggers on write a questionnaire for.
disable-model-invocation: true
---

<!--
Vendored from mattpocock/skills 1.2.3, path skills/productivity/to-questionnaire/SKILL.md,
copied 2026-10-08. Licensed under the MIT License, Copyright (c) 2026 Matt Pocock. The
full licence text is in the LICENSE file beside this one.

THIS FILE HAS BEEN MODIFIED from the original. Changes:
  1. Output location: upstream wrote the questionnaire into the current directory, which
     is a repository edit in a canonical checkout. It now goes to a path the user names,
     or to ~/tmp, never the current directory.
  2. The template's angle-bracket placeholders became {braces} inside a fenced block,
     because this repository's validator reads angle brackets as unclosed XML tags.
  3. Rewrote the frontmatter description to this repository's authoring contract.
The three steps, the document structure, and the template content are upstream's and are
unchanged in substance.
-->

# To Questionnaire

TRIGGER
+ "write a questionnaire for", "what should I ask them", "ask them to fill in"
+ the user needs knowledge only one other person holds before deciding
- the user can answer the questions themself → `skill://grilling`

Turn something the user cannot answer alone into a **questionnaire**: a Markdown document
they hand to one person to fill in async, or fill out together over a meeting. The
recipient holds knowledge the user lacks; the questionnaire pulls it out of them.

**Grill the send, not the subject.** Interview the user only about the _send_, which they
can always answer: who it goes to, and what they need back. The questions in the document
then target the **gap** between what the recipient knows and what the user needs.

## Workflow

1. **Who is it going to?** Ask, in one exchange, the recipient's role, expertise, and
   relationship to the user. This fixes the questionnaire's tone and how much context it
   must carry. → you know who the recipient is and what they know that the user does not.
2. **What do you need back?** Ask, in one exchange, the specific decisions or facts the
   user cannot resolve alone and needs from this person. → a concrete list of what the
   user must walk away able to do or decide.
3. **Write the questionnaire.** Draft questions aimed at the gap from steps 1-2, following
   the document structure below. Write it to the path the user names; with no path, write
   `~/tmp/to-questionnaire-{slug}.md` (slug from the topic). Report the absolute path.
   → the file exists and every item the user named in step 2 is covered by a question.

## Document structure

Frame the document as a **discovery questionnaire**: the user lacks context, the recipient
holds it. Order questions most-important-first, since async means you may only get one
pass, and group them under `##` headings by theme once there are more than a handful.

```markdown
# {Questionnaire title}

**Purpose:** why this questionnaire exists and the decision riding on it.

**From:** {the user}, **To:** {the recipient}, **How your answers will be used:** {where they go}

## Context

One paragraph orienting a recipient who was not in the user's head. Enough to answer
well, not a page.

## How to answer

Deadline and rough effort. Partial answers and "I don't know" are useful: flag anything
you are unsure of rather than skipping it.

## {Theme heading}

### What load is the system expected to handle at launch?

_Why this matters: it decides whether we provision for burst traffic now or defer it._

>

## Anything else?

A closing catch-all: anything we did not ask that we should know?
```

One `##` section per theme. Under each, its questions, most-important-first. Every
question is one idea, never compound, with an answer stub directly beneath, and a one-line
_why this matters_ only where the question could be misread or invite a throwaway answer.

## Rules

NOT Write the questionnaire into the current directory or any repository checkout unless
  the user names that path.
NOT Send the questionnaire; the user hands it over.
