---
name: journey-write
description: Use when authoring or amending user journeys from feature evidence, grilling on unknowns and checking the definition-of-ready.
---

# journey-write

Write or amend journeys per the format spec. The journeys directory's
`FORMAT.md` is normative -- read it first, along with `README.md` (config)
and `INDEX.md`. If no journeys directory exists, run `journey-init` first.

Delegate the drafting to the `journey-scribe` agent when working on more
than one journey; do it inline for a single journey. If the
`journey-scribe` agent type is not available in this environment, draft
inline under the same boundaries. Elicitation always
happens HERE, in the main context -- subagents cannot question the user.
The scribe receives the answers and returns open questions.

## Gather authoring input

The journey is **spec-informed but independently owned**: read whatever
change record exists -- feature spec, merged PRs, diff, design docs, the
running feature itself -- to learn intended behavior. Record references in
`trace:` (repo's own vocabulary). Never copy acceptance scenarios verbatim;
a journey describes what a *user* does and observes end to end, which may
span many specs and includes glue no spec contains.

## Elicitation -- the grilling protocol

Draft first when there is evidence to draft from: read it, produce the
best draft it supports, and interrogate the user only on the genuine
holes -- decisions the evidence cannot answer. Asking what the repo already
answers is noise; asking about real forks is signal.

When the repo has little or no relevant evidence (greenfield journey, a
feature that exists mostly in the user's head), grilling IS the primary
input: skip the evidence hunt, open with a skeleton draft of your best
understanding, and grill from there. Gather info first only when it makes
sense -- never stall a journey waiting for documents that don't exist.

In a headless context with no question channel (e.g. running as a
subagent), owner-supplied statements from the invocation stand in for
grilling answers; anything they don't cover goes to your report as an open
question.

Grill with AskUserQuestion, up to 4 questions per round:

- Each question states a **tension** -- why the answer isn't obvious, what
  breaks under each reading -- then offers 2 to 4 concrete, mutually exclusive
  options with their consequences spelled out. Mark a recommendation and
  put it first.
- Challenge the user's framing when the evidence contradicts it. If they
  describe the feature one way and the code/spec says another, surface the
  conflict as a question, not silently pick a side.
- Target the definition-of-ready gaps by name: an unmeasurable success
  criterion, a missing "done" observation, an unguarded trust point, an
  unscoped error branch. Quote the draft text you would write under each
  option when it sharpens the choice.
- Never ask permission ("shall I write it?"), only decisions.

**How far:** grill until the FORMAT.md definition-of-ready audit passes,
capped at 3 rounds by default (the user saying "good enough" ends it
early). At the cap, do NOT silently park unknowns: present every remaining
gap in one final question -- provide the missing information, or explicitly
accept each ambiguity. Only a user-confirmed ambiguity becomes a **Known
gaps** entry (recorded with "accepted by user, <date>"); an unconfirmed
gap keeps the journey at `status: draft` with the open questions in your
report. MUST never invent missing information or accept an ambiguity on the
user's behalf.

## The definition-of-ready audit

Before a journey is reported done, audit it line by line against
FORMAT.md's "Definition of ready" checklist and include the audit in your
report: each item pass/fail, and for each fail either the grill question
it raised or the Known-gaps entry that records it. A journey with open
audit fails stays `status: draft`.

## New journey

1. Allocate the next free `J<n>` id (check INDEX.md; ids are never reused).
2. Draft from `'/Users/sjors/.claude/skills/journey-init/templates/journey.template.md'`:
   - Steps are interface-agnostic user actions with observable `Expect:`
     assertions. Add `Expect (negative):` wherever trust depends on
     something NOT happening (no silent writes, no data loss).
   - `surfaces:` must name the product surfaces touched -- this powers
     changed-only validation. Add new globs to README.md's surface map if
     the mapping is not obvious.
   - `interfaces:` names README.md profiles able to run this journey.
   - Status `draft` until first validated; `version: 1`;
     `last_reviewed:` today.
3. Lint + reindex:
   `python3 <journeys-dir>/journeys.py lint <journeys-dir>` then
   `python3 <journeys-dir>/journeys.py index <journeys-dir>`.

## Amend an existing journey

Classify the change first (FORMAT.md, "three change species"):

- **Correction** (doc is wrong about existing reality): fix the body, no
  delta entry, no version bump. Commit as `journey(J<id>): correct ...`.
- **Behavior delta** (product intentionally changed): edit the body to the
  new truth, bump `version`, add one compact Δ entry citing intent evidence
  (PR/spec/commit -- you were given it or found it; if you cannot cite any,
  stop and ask, do not amend).
- New steps get inserted ids (`S3a`), never renumber; removed steps retire
  their ids.

## Migration of an existing doc

Rewrite, don't transliterate: extract goal, preconditions, user-visible
steps and assertions from the legacy doc; drop tool-specific mechanics into
the relevant README.md interface profile notes instead of the journey.
Carry over known-gaps honestly. Legacy history does not become delta
entries -- the new journey starts at `version: 1` as current truth, with the
legacy doc linked in `trace:`. Propose deleting or pointer-stubbing the
legacy doc; let the user decide.

## Always

- Never validate as part of authoring: do not invoke journey-verify (or
  drive the product against the steps) on a journey you just wrote or
  amended. First validation must come from a fresh context -- a validator
  certifying a document its own context authored is self-review. End by
  offering journey-verify as the next step instead.
- End by running lint + index; both must be clean.
- Report which journeys were created/amended, at which versions, and any
  surface-map or profile updates made to README.md.
