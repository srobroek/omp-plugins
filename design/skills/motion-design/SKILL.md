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

1. Route by what the motion actually is. -> the chosen route is named in the report header.
   - PRIMARY, any rendered surface: MotionLint, for a deterministic scored pass. It leads
     because it measures what shipped: it caught an unbranched 420ms transform and scored
     the surface. `npx --yes playwright install chromium` once, then
     `npx --yes motionlint audit "<url>" --json audit.json --ci`.
     It also writes `.motionlint/audit/index.html` into the CALLER's working directory
     rather than a temp dir, and nothing gitignores it. Run it from a scratch directory, or
     add `.motionlint/` to `.gitignore` first, or the pass leaves a report to be committed
     by accident.
     `--ci` does NOT gate on findings. Measured: it exited 0 while the same run reported the
     accessibility warning `No prefers-reduced-motion path`. Read `audit.json` and judge the
     findings; the exit code alone proves nothing.
   - AUTHORING React `motion.X` JSX values, and nothing else: `ss-motion`, whose own title
     is "Motion Seed Applier". It applies values; it does not review a surface. Its own
     **When NOT to use** says: "For non-React motion (CSS-only transitions, GSAP) - this
     skill targets motion.X JSX only." So on CSS transitions, which is most motion, it
     contributes nothing at all, and MotionLint above plus the rules below do the work.
2. Check `ss-motion` is in your available skills BEFORE loading it, and only once the target
   is React `motion.X`. Reading a `skill://` path that does not exist throws `Unknown skill`.
   -> present: LOAD and follow. Absent: do NOT invent a duration table or an easing set.
   Report the gap, name the install command from
   `skill://motion-design/references/upstream.md`, and ASK the user to run it. An install
   applies from the NEXT session, since OMP discovers plugins at startup, so never install
   and retry within this one. MotionLint measures a surface and never authors values, so it
   is a measurement route rather than a stand-in for the applier: the authoring itself waits
   for the install.
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
