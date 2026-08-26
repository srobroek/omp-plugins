---
name: motion-design
description: Authors durations, easings, and reduced-motion branches from the project scale. Triggers on add an animation or make this feel smoother.
---

# Motion Design

Phase BUILD. Take motion from the system's scale and give every animation an opt-out.

TRIGGER
+ "add an animation", "make this feel smoother", "why does this feel janky"
+ a transition, transform, or keyframe is about to be written
- verifying motion already implemented -> `ui-review`
- platform motion conventions -> `platform-conformance`
- discovering whether a motion scale exists -> `design-system-audit`

## Workflow

1. Route in this order. -> the chosen route is named in the report header.
   - `ss-motion` for authoring durations, easings, and motion tokens. The winner.
   - MotionLint for a deterministic scored pass over a running surface:
     `npx playwright install chromium` once, then
     `npx --yes motionlint audit "<url>" --json audit.json --ci`.
2. Check `ss-motion` is in your available skills BEFORE loading it. Reading a
   `skill://` path that does not exist throws `Unknown skill`. -> present: LOAD and follow.
   Absent: STOP, emit the install command from
   `skill://motion-design/references/upstream.md`, and run it.
3. Read the project's existing durations and easings first via
   `skill://design-system-audit`. -> every value used is a token that already exists, or
   the gate below fires.
4. Verify the result on the running surface with `skill://ui-review`, including the
   reduced-motion branch. -> `prefers-reduced-motion` observed to change behaviour, not
   assumed to.

GATES
ASK Introducing a new duration or easing step. A new scale is a system decision.

## Rules

MUST Give every transition over 200ms and every transform animation a
  `prefers-reduced-motion` branch. Motion without an opt-out is an accessibility defect,
  not a taste question.
MUST Take every duration and easing from the discovered scale.
MUST Verify reduced motion by driving it, because a media-query branch that was never
  exercised is untested.
DEFAULT Animate transform and opacity. They composite; layout and paint properties do not.
NOT Bounce or elastic easing. It reads as machine-generated.
NOT Animate a property that triggers layout when a transform expresses the same change.

OUTPUT
L1 MOTION: applied -- route used, plus the tokens taken.
   Reduced -- the reduced-motion branch, and how it was observed.
   Open -- any value that needed a new scale step, left for the user.
CAP 100w
