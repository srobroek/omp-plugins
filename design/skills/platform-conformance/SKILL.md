---
name: platform-conformance
description: Checks a surface against its platform's own design guidelines. Triggers on does this follow HIG or Material or platform conventions.
---

# Platform Conformance

Phase VERIFY. Judge against the vendor's own guidance for the target platform.

TRIGGER
+ "does this follow HIG", "Material Design", "platform conventions"
+ building or reviewing a surface for a named platform rather than the generic web
- WCAG conformance -> `accessibility-audit`
- the project's own system -> `design-system-audit`
- durations and easings -> `motion-design`

## Workflow

1. Route by target platform to the upstream skill. -> the chosen route is named in the
   report header.

   | target | upstream skill |
   |---|---|
   | iPhone | `ios-design-guidelines` |
   | iPad | `ipados-design-guidelines` |
   | Mac | `macos-design-guidelines` |
   | Apple Watch | `watchos-design-guidelines` |
   | Vision Pro | `visionos-design-guidelines` |
   | Apple TV | `tvos-design-guidelines` |
   | Android | `android-design-guidelines` |
   | web | `web-design-guidelines` |

2. Add `modern-web-guidance` for current web platform practice, which is a separate
   question from convention conformance. -> baseline support and current APIs cited.
3. Check the routed name is in your available skills BEFORE loading it. Reading a
   `skill://` path that does not exist throws `Unknown skill`. -> present: LOAD and follow.
   Absent: STOP, emit the install command from
   `skill://platform-conformance/references/upstream.md`, and run it. Platform guidance
   restated from memory is the failure this skill exists to prevent.
4. Detect the platform from repository markers rather than asking: `package.json`
   dependencies, `pubspec.yaml`, `*.xcodeproj` or `Package.swift`, `composer.json`, or
   `app.json` plus a `react-native` dependency. -> the platform is stated with the marker
   that proved it. ASK only when nothing is detectable.

## Rules

MUST Take platform guidance from the routed upstream, never from memory. Vendor guidance
  changes and a remembered rule is a stale rule.
MUST Treat an accessibility requirement as winning over any platform guideline. A
  guideline never authorises an inaccessible surface.
MUST Surface a conflict between a guideline and the project's DESIGN.md rather than
  silently resolving it. Choosing a winner is the user's call.
DEFAULT Judge one platform per pass. A cross-platform surface gets one pass per target.
NOT Apply Apple guidance to Android or the reverse, or cite a guideline you did not read.

OUTPUT
L1 VERDICT: CONFORMS | DEVIATES | BLOCKED -- platform plus route, one sentence.
   Deviations -- guideline, what the surface does, the conforming alternative.
   Conflicts -- guideline versus DESIGN.md, both stated, left open.
CAP 140w clean · 240w with deviations
