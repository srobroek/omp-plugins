# Debugging hard bugs

Read for a hard bug, a flaky failure, or a performance regression. Skip a step when the
evidence already settles it, and say which step you skipped.

## Build a feedback loop

A tight pass/fail signal for this bug makes bisection, hypotheses, and instrumentation
mechanical. Try these roughly in order:

1. A failing test at whatever seam reaches the bug: unit, integration, end-to-end.
2. A curl or HTTP script against a running dev server.
3. A CLI invocation on a fixture input, diffing stdout against a known-good snapshot.
4. A headless browser script that drives the UI and asserts on DOM, console, or network.
5. A replayed capture: a saved request, payload, or event log run through the code path.
6. A throwaway harness: a minimal subset of the system reaching the bug in one call.
7. A property or fuzz loop: many random inputs, looking for the failure mode.
8. A bisection harness: when the bug appeared between two known states, automate
   "boot at state X, check, repeat" and hand it to `git bisect run`.
9. A differential loop: the same input through the old and new version, diffing outputs.
10. A human-driven step, last resort and only in an interactive session: give the user
    the exact steps and ask for the observed result, redacted.

Then tighten the loop: make it faster (cache setup, narrow scope), sharper (assert the
specific symptom, not "did not crash"), and deterministic (pin time, seed randomness,
isolate the filesystem, freeze the network). For a flaky bug, raise the reproduction
rate instead of chasing a clean repro: loop the trigger, parallelise, add stress, inject
sleeps. A 50% flake is debuggable; 1% is not.

No loop is possible: say so and list what you tried. Ask for an environment that
reproduces it, a redacted captured artifact, or permission for temporary
instrumentation when a user is reachable. Without a loop, diagnose from source and the
reported evidence, and label the conclusion unverified.

## Minimise

Once the loop fails, cut inputs, callers, config, data, and steps one at a time,
re-running after each cut, until every remaining element is load-bearing: removing any
one makes the loop pass. The minimal case becomes the regression test.

## Hypothesise

Generate 3-5 ranked hypotheses before testing any; a single hypothesis anchors on the
first plausible idea. Each must be falsifiable: "if X is the cause, changing Y makes the
bug disappear and changing Z makes it worse." A hypothesis with no prediction is
discarded or sharpened. In an interactive session, show the ranked list before testing:
the user may re-rank it at once. Otherwise proceed with your ranking.

## Instrument

- Map each probe to one prediction and change one variable at a time.
- Prefer a debugger or REPL to logs; then targeted logs at the boundaries that separate
  hypotheses. Never log everything and grep.
- Tag every debug log with a unique prefix such as `[DEBUG-a4f2]`, so cleanup is one grep.
- Performance regression: logs are usually wrong. Establish a baseline measurement first
  (timing harness, profiler, query plan), then bisect.

## Pick the regression seam

Write the regression test at a seam that exercises the real bug pattern as it occurs at
the call site. A test at a seam too shallow to replicate the triggering chain (for
example, a single-caller unit test for a multi-caller bug) gives false confidence. When
no correct seam exists, report that as a finding: the architecture prevents locking the
bug down. Test selection and fidelity are in [verification.md](verification.md).

## Redact and clean up

Write `[REDACTED]` for every secret in commands, outputs, and artifacts you show; keep
credentials in environment variables; quote only the signal-carrying lines of an artifact.

Before declaring done:

- the original repro no longer reproduces (re-run the first loop);
- the regression test passes, or the missing seam is documented;
- every `[DEBUG-...]` probe is removed (grep the prefix) and throwaway harnesses are
  deleted or moved to a clearly marked location;
- the confirmed hypothesis is stated in the commit or PR message.
