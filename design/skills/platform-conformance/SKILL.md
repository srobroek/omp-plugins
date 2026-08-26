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

2. For current web practice, prefer the CLI, which needs NO plugin install:
   `npx --yes modern-web-guidance@latest search "<topic>"` returns ids, then
   `npx --yes modern-web-guidance@latest retrieve "<id,id>"` takes them comma-separated.
   Neither is a bare command. It needs network.
   -> baseline support and current APIs cited from the tool, not from memory.
3. Check the routed platform skill is in your available skills BEFORE loading it. Reading a
   `skill://` path that does not exist throws `Unknown skill`. -> present: LOAD and follow.
   Absent: do NOT improvise. Platform guidance restated from memory is the failure this
   skill exists to prevent. Instead report the gap, name the install command from
   `skill://platform-conformance/references/upstream.md`, and ASK the user to run it. An
   install applies from the NEXT session, because OMP discovers plugins at startup, so never
   install and retry within this one. The eight platform skills are prose and have no npm
   package, so no CLI substitutes for them.
4. Detect the ecosystem from repository markers rather than asking: `package.json`
   dependencies, `pubspec.yaml`, `*.xcodeproj` or `Package.swift`, `composer.json`, or
   `app.json` plus a `react-native` dependency. -> the ecosystem is stated with the marker
   that proved it.
5. Narrow the ecosystem to ONE of the eight route targets, because no marker in step 4
   does that on its own. `Package.swift` proves Swift, never which Apple OS.
   -> read the deployment target: `platforms:` in `Package.swift`, or
   `*_DEPLOYMENT_TARGET` build settings in an `.xcodeproj`. For `package.json`, a `next`,
   `vite`, `astro`, or `react-dom` dependency implies web. ASK when the evidence still
   names two or more targets, and NEVER pick the most common one silently.
6. Handle a repository carrying markers for several ecosystems, which is normal in a
   monorepo. -> judge one target per pass, name the subtree each marker came from, and ASK
   which the user means when the request does not say.

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
