---
name: motion-design
description: Authors durations, easings, and reduced-motion branches from the project scale. Triggers when adding or changing animation.
---

# Motion Design

Phase BUILD. Take motion from the system's scale and give every animation an opt-out.

TRIGGER
+ adding or changing an animation, transition, transform, or keyframe
- verifying motion already implemented -> `ui-review`
- platform motion conventions -> `platform-conformance`
- discovering whether a motion scale exists -> `design-system-audit`

## Workflow

1. Route by what the motion actually is. -> the chosen route is named in the report header.
   - PRIMARY, any rendered surface: use the project's established motion measurement route.
   - AUTHORING: use the project's established motion authoring route when one exists.
2. Read the project's existing durations and easings first via
   `skill://design-system-audit`. -> every value used is a token that already exists, or
   the gate below fires.
3. Verify the result on the running surface with `skill://ui-review`, including the
   reduced-motion branch. -> `prefers-reduced-motion` observed to change behaviour, not
   assumed to.
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
MUST Read MotionLint's `audit.json` findings before calling the reduced-motion MUST above
  satisfied. Its `--ci` exit code is not that gate: exit 0 alongside a
  `No prefers-reduced-motion path` warning in the same report is the measured behaviour.
DEFAULT Animate transform and opacity. They composite; layout and paint properties do not.
NOT Bounce or elastic easing. It reads as machine-generated.
NOT Animate a property that triggers layout when a transform expresses the same change.

OUTPUT
L1 MOTION: applied -- route used, plus the tokens taken.
   Reduced -- the reduced-motion branch, and how it was observed.
   Open -- any value that needed a new scale step, left for the user.
CAP 100w
