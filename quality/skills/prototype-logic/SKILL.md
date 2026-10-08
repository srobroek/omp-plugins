---
name: prototype-logic
description: Builds a throwaway single-file HTML demo over a pure reducer or state machine. Triggers on does this state model work or prototype the logic.
---

<!--
Vendored from mattpocock/skills 1.2.3, paths skills/engineering/prototype/SKILL.md and
skills/engineering/prototype/LOGIC.md, copied 2026-10-08. Licensed under the MIT License,
Copyright (c) 2026 Matt Pocock. The full licence text is in the LICENSE file beside this
one.

THIS FILE HAS BEEN MODIFIED from the original. Changes:
  1. Only the LOGIC branch is vendored. The UI branch (in-app ?variant= variants) is a
     route in design-prototype, so the "what should this look like" trigger stays there.
  2. Promotion: upstream lifted the untested module into real code on its own. The pure
     module now enters real code only with tests at its real seam.
  3. Location and capture: the demo goes to a user-named path or ~/tmp, never into a
     checkout, and is not committed to a side branch outside the delivery workflow.
  4. Added a run check before hand-over, and rewrote the frontmatter description to this
     repository's authoring contract.
The demo layout, the pure-module shapes, the walkthrough design, and the anti-patterns
are upstream's and are unchanged in substance.
-->

# Logic prototype

TRIGGER
+ "does this state model work", "prototype the logic", "I'm not sure this state machine handles X then Y"
+ a data model or transition set someone wants to push through real cases before writing it
- "what should this look like", a wireframe, or UI variants → `skill://design-prototype`
- the logic is settled and needs implementing → `skill://quality-code-design`

A logic prototype is a single self-contained HTML file that lets anyone drive a state
model by clicking buttons. It answers a question about business logic, state transitions,
or data shape: the kind of thing that looks reasonable on paper and only feels wrong once
pushed through real cases. It speaks the domain's language, so a non-developer can drive it.

## Workflow

1. **State the question.** One paragraph naming the state model and the question, shown
   in a visible intro at the top of the demo, not only in a comment.
2. **Isolate the logic in one pure module**, in a single `<script>` block, shaped by the
   question:
   - a pure reducer `(state, action) => state` when actions are discrete events;
   - a state machine with explicit states and transitions when "which actions are legal
     now" is part of the question;
   - a few pure functions over a plain data type when there is no current state;
   - a module with a clear method surface when the logic owns ongoing internal state.
   No DOM, no `document`, no handlers inside it: the page calls in, nothing flows back.
3. **Build the page** as plain inline HTML, CSS, and JS: no framework, bundler, or server.
   Top to bottom: title and the question; the current state as a labelled panel, re-rendered
   after every click with the change called out; one free-play button per action; guided
   walkthroughs, one tab per scenario, each a plain-language description over the ordered
   buttons to press, starting from a reset initial state. Cover the happy path, a tricky
   edge case, and an attempt at something that should be illegal. Restrained styling: one
   accent colour, no animation.
4. **Write and check it.** Write the file to the path the user names; with no path, to
   `~/tmp/prototype-logic-{slug}/index.html`. When a browser tool is available, open the
   file and run each walkthrough once. → report the absolute path and any console error.
5. **Hand it over** and iterate: "wait, that shouldn't be possible" is a bug in the idea,
   which is the point. Add actions or scenarios on request.
6. **Capture the answer**: record the verdict and the question it settled where the user
   tracks the decision. The validated module is the only part that can move into real code.

## Rules

MUST Add tests at the module's real seam before any part of the prototype enters real
  code. A clicked demo is evidence about a design, not proof the implementation is correct.
MUST Keep state in memory. A scratch store named "PROTOTYPE, wipe me" is allowed only
  when persistence is the question.
NOT Add tests, error handling, or abstractions to the prototype itself; it answers one
  question and is thrown away.
NOT Blur the module and the page: a module that touches the DOM cannot be lifted.
NOT Ship the HTML shell into production.
