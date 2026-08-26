---
name: ux-copy
description: "Writes or reviews UX copy: microcopy, error messages, empty states, CTAs. Triggers on write copy for or what should this button say."
---

<!--
Vendored from anthropics/knowledge-work-plugins, path design/skills/ux-copy/SKILL.md,
copied 2026-08-26. Licensed under Apache License 2.0; see the LICENSE file beside this
one. Upstream ships no NOTICE file.

THIS FILE HAS BEEN MODIFIED from the original. Changes, all made so the skill is correct
in a repository with no design-source connector:
  1. Removed the link to ../../CONNECTORS.md, which does not exist here, and replaced it
     with a statement that connectors are out of scope.
  2. Replaced the "If Connectors Available" section, which instructed the reader to pull
     from a connected knowledge base and Figma, with the same out-of-scope statement.
  3. Replaced the slash-command "Usage" block, which read `/ux-copy $ARGUMENTS`, with
     skill invocation, because this is loaded as a skill and takes no argument string.
  4. Rewrote the frontmatter description to this repository's contract: under 25 words,
     third person, no em-dash.
All substantive guidance below, being the principles, copy patterns, voice and tone,
output template, and tips, is upstream's and is unchanged.
-->

# UX Copy

Write or review UX copy for any interface context.

Design-source connectors are out of scope here. Take context from the code and from the
running surface instead: `skill://design-system-audit` for the system, and
`skill://ui-review` to read character budgets and truncation in place.

## What I Need From You

- **Context**: What screen, flow, or feature?
- **User state**: What is the user trying to do? How are they feeling?
- **Tone**: Formal, friendly, playful, reassuring?
- **Constraints**: Character limits, platform guidelines?

## Principles

1. **Clear**: Say exactly what you mean. No jargon, no ambiguity.
2. **Concise**: Use the fewest words that convey the full meaning.
3. **Consistent**: Same terms for the same things everywhere.
4. **Useful**: Every word should help the user accomplish their goal.
5. **Human**: Write like a helpful person, not a robot.

## Copy Patterns

### CTAs
- Start with a verb: "Start free trial", "Save changes", "Download report"
- Be specific: "Create account" not "Submit"
- Match the outcome to the label

### Error Messages
Structure: What happened + Why + How to fix
- "Payment declined. Your card was declined by your bank. Try a different card or contact your bank."

### Empty States
Structure: What this is + Why it's empty + How to start
- "No projects yet. Create your first project to start collaborating with your team."

### Confirmation Dialogs
- Make the action clear: "Delete 3 files?" not "Are you sure?"
- Describe consequences: "This can't be undone"
- Label buttons with the action: "Delete files" / "Keep files" not "OK" / "Cancel"

### Tooltips
- Concise, helpful, never obvious

### Loading States
- Set expectations, reduce anxiety

### Onboarding
- Progressive disclosure, one concept at a time

## Voice and Tone

Adapt tone to context:
- **Success**: Celebratory but not over the top
- **Error**: Empathetic and helpful
- **Warning**: Clear and actionable
- **Neutral**: Informative and concise

## Output

```markdown
## UX Copy: [Context]

### Recommended Copy
**[Element]**: [Copy]

### Alternatives
| Option | Copy | Tone | Best For |
|--------|------|------|----------|
| A | [Copy] | [Tone] | [When to use] |
| B | [Copy] | [Tone] | [When to use] |
| C | [Copy] | [Tone] | [When to use] |

### Rationale
[Why this copy works, covering user context, clarity, action-orientation]

### Localization Notes
[Anything translators should know, such as idioms to avoid, character expansion, cultural context]
```

## Tips

1. **Be specific about context**: "Error message when payment fails" is better than "error message."
2. **Share your brand voice**: "We're professional but warm" helps match your tone.
3. **Consider the user's emotional state**: Error messages need empathy. Success messages can celebrate.
