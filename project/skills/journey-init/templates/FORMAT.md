# User Journey Format

Normative spec for every artifact under this journeys directory. Installed by
`journey-init`; the copy in the repo is authoritative for that repo. Agents and
humans read the same files -- nothing here requires a runtime beyond a text
editor, `git`, and `python3` for the index/lint helper.

## Directory layout

```
<journeys-dir>/                 # location set at init (default docs/journeys/)
  FORMAT.md                     # this spec
  README.md                     # per-project config: reporter, interface
                                #   profiles, surface map, fix-loop policy
  journeys.py                   # index/lint/prune helper — travels with the
                                #   repo; installed by journey-init
  INDEX.md                      # generated routing table — do not hand-edit
  TRACKER.md                    # only when reporter is `local`
  J07-<slug>/
    journey.md                  # THE journey — current expected behavior
    runs/
      2026-07-14T09-31Z.md      # one file per validation run
```

## The journey file

`journey.md` is always **current truth**: what the product is expected to do
today, end to end, from the user's point of view. It is never a historical
record -- git is the historical record.

````markdown
---
id: J07                    # stable, unique in this repo, never reused
title: Short user-goal phrase
version: 3                 # bumped on behavior deltas only, never corrections
status: active             # draft | active | deprecated
last_reviewed: 2026-07-10  # consolidation checkpoint; delta-log window start
actors: [primary-user]     # who performs this journey
surfaces: [checkout, cart] # product surfaces touched — the changed-only key
interfaces: [web-ui]       # config.yml interface_profiles able to run this
trace: []                  # optional links in the repo's own vocabulary:
                           #   spec IDs, FR IDs, PRD sections, tickets
---

## Goal
One paragraph: what the user is trying to accomplish and what "done" means.

## Preconditions
- P1: ... (each precondition gets a stable P-id)

## Steps
### S1 — Imperative step title {#S1}
- **Do:** what the user does, interface-agnostic.
- **Expect:** observable outcome(s). Every Expect is an assertion.
- **Expect (negative):** what must NOT happen, when trust depends on it.
- **Trace:** optional per-step links (spec FR, ticket).

## Success criteria
- SC1: journey-level outcomes, referencing step ids.

## Known gaps
- G1: steps or environments that cannot currently be validated, and why.

## Delta log
- **Δ3** 2026-07-14 · S3, +S3a · behavior-change
  One-to-three lines: what changed, user-visibly.
  Evidence: PR #691, spec-052/FR-004 · by: journey-scribe (intent-gated)
````

### Definition of ready

A journey may leave `status: draft` only when all of these hold. Authoring
skills audit against this list. Whatever cannot be satisfied becomes a
**Known gaps** entry only after the user explicitly confirms the ambiguity
is acceptable (record "accepted by user, <date>" on the entry); agents
never accept a gap on the user's behalf, and missing information is never
invented. Unconfirmed gaps keep the journey in `draft`.

- [ ] **Goal** names the actor's outcome and an observable definition of
      "done" -- not a feature description.
- [ ] Every **Expect** is observable and falsifiable. "Works correctly",
      "handles gracefully", and other unfalsifiable phrasing are defects.
- [ ] Every **success criterion** has a concrete target: a count, a
      threshold, a state that either holds or doesn't. Where the user has
      real KPIs (time-to-complete, error budget, conversion), the SC cites
      them; where they don't, the SC still picks a checkable proxy.
- [ ] **Expect (negative)** guards every point where trust depends on
      something not happening (silent writes, data loss, destructive
      actions without confirmation, leaking state).
- [ ] **Preconditions** are sufficient to reach S1 from a clean
      environment, and each is establishable (or its gap is documented).
- [ ] `actors`, `surfaces`, and `interfaces` are filled; `trace` links the
      change records that informed authoring, or is explicitly empty.
- [ ] Error and edge branches are explicitly scoped: covered in steps,
      or listed under Known gaps as out of scope -- never simply absent.

Promotion is event-driven: once the checklist holds, the first validation
run in which every step passes records `draft` → `active` (the verify
skill owns this transition); a consolidation checkpoint may also promote
with the human's blessing. Nothing else changes `status`.

### Step identity rules

- Step ids are `S<n>` with optional letter suffixes (`S3a`) for insertions.
- Ids are **stable**: never renumber, never reuse a retired id. Removing a
  step removes its heading; the id stays retired.
- Every step heading carries an explicit anchor `{#S<id>}` so links survive
  title edits.
- Preconditions (`P<n>`), success criteria (`SC<n>`), and gaps (`G<n>`)
  follow the same stability rule.
- Everything that refers to a step -- deltas, run results, findings -- cites
  `J<id>/S<id>`.

### The three change species

| Species | What it is | Body | Delta log | Version | History |
|---|---|---|---|---|---|
| **Correction** | The doc misdescribed existing behavior | edit in place | nothing | unchanged | git commit `journey(J07): correct S2 ...` |
| **Behavior delta** | The product intentionally changed | edit in place | one compact Δ entry | +1 | git + Δ entry until flushed |
| **Run result** | What happened when validated | never touches journey.md | never | -- | `runs/` file + reporter |

A **correction** needs no ceremony because no one ever needs to be told "we
once described this wrong" -- fix the text, commit. A **behavior delta** needs
its Δ entry because the next validator and the next human reviewer must see
what changed since the document was last trusted, with the evidence that the
change was intended.

### Delta log entries

```
- **Δ<version>** <date> · <step ids touched, +new ids> · behavior-change
  <1–3 lines describing the user-visible change>
  Evidence: <PR / spec / changelog / commit refs> · by: <human name | agent (intent-gated)>
```

The delta log is a **window, not an archive**. It holds only entries newer
than `last_reviewed`. At a consolidation checkpoint (see below) older entries
are deleted from the file. Steady-state file size is current behavior plus a
handful of recent deltas; the log cannot grow monotonically.

### Amendment authority (intent gating)

An agent may amend a journey **only** when it can cite intent evidence -- a
merged PR, spec, changelog entry, commit message, or an explicit user
instruction stating the behavior changed on purpose. The evidence must
itself STATE the behavior change: a commit that claims non-behavioral scope
("refactor", "cleanup") while its diff changes behavior is not intent
evidence -- it is grounds for suspicion. The evidence goes in the
Δ entry. With no intent evidence, the journey stays unchanged, the run marks
the step failing, and a finding is filed as `suspected-regression`. Agents
never resolve `product-question` findings; those always go to a human.

## Run files

One file per validation run: `runs/<UTC timestamp>.md`, machine-parsable
frontmatter, human-readable evidence body.

````markdown
---
journey: J07
journey_version: 3
commit: <git sha validated against>
date: 2026-07-14T09:31Z
mode: full                # full | changed-only(S3,S3a) | smoke
interface: web-ui (playwright)
result: fail              # pass | fail | blocked
steps: {S1: pass, S2: pass, S3: fail, S3a: skipped}
findings: [JV-0042]       # reporter-assigned ids
---
## S3 — FAIL
Expected ... observed ... Evidence: <screenshots, command output, logs>.
Triage: suspected-regression — no intent evidence in merges since v3.
→ Filed as JV-0042 (github: #712).
````

Step result values: `pass | fail | blocked | skipped`. `blocked` means the
step could not be attempted (environment, missing fixture, prior failure);
`skipped` means deliberately out of scope for this run's mode. A step
unreachable because an earlier step in the same run failed is `blocked` --
the defect is recorded once, on the step that owns it; journey-level impact
shows in the run `result` and the success criteria, never by double-marking.

## Triage taxonomy

Every mismatch between journey and observed behavior gets exactly one triage:

- `correction` -- the doc was wrong about long-standing reality. Fix body.
- `intended-change` -- intent evidence found. Amend body + Δ entry, version+1.
- `suspected-regression` -- no intent evidence. File finding; journey unchanged.
- `product-question` -- reality and doc disagree and neither is clearly right;
  needs a human product decision. File finding flagged `product-decision`.
- `environment` -- the harness/fixture/driver failed, not the product. Record
  in the run file only; do not file to the tracker.

## Findings

Findings go to the reporter configured in the journeys `README.md`
frontmatter. Regardless of
tracker, every finding body embeds this block so journey↔finding linkage
survives any label scheme or tracker migration:

```
<!-- journey-finding
journey: J07
step: S3
journey_version: 3
commit: <sha>
run: 2026-07-14T09-31Z
triage: suspected-regression
severity: P2
-->
```

Followed by human sections: **Summary**, **Repro** (the journey steps to
replay), **Expected vs Observed**, **Evidence**, **Triage rationale**.
Severity: P1 (journey-blocking) / P2 (step fails, journey completable) /
P3 (cosmetic or partial expectation miss).

Local reporter (`reporter.kind: local`): findings are appended to
`TRACKER.md` as `## JV-<seq> — <title>` sections carrying the same block plus
a `status: open | fixed | wontfix` line.

## Consolidation checkpoints

Consolidation is how the format stays small and trusted. It is always
human-approved (an agent may propose, only a human blesses):

1. Human reviews the journey body as current truth.
2. `last_reviewed` moves to today; Δ entries older than it are deleted.
3. `runs/` is pruned to the newest `runs_keep` files (README frontmatter).
4. `INDEX.md` is regenerated.

Git retains everything deleted in steps 2 to 3.

## INDEX.md

Generated by the `journeys.py` helper (never hand-edited): one row per
journey -- id, title, status, version, surfaces, interfaces, last_reviewed,
last run date/result. It is the routing table for "which journeys does this
change touch" and the first file an agent reads.
