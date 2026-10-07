# Verification proportional to risk

Read when selecting tests, reproducing a defect, or making verification or performance claims. Follow required project gates and the worker/lead division of verification responsibility.

## Acceptance and independent expectations

**Do:** derive checks from the requested behavior, contracts, and credible failures. For a behavioral bug, reproduce the failure before the fix when feasible, then show that the same check passes. Cover relevant boundaries, errors, and preserved behavior.
**Do not:** copy the implementation into the expected result, weaken an assertion to match generated behavior, or call an unavailable check a pass.

Bad: a rounding bug is "fixed" by changing the test's expected total to the new output.
Good: establish the rounding contract independently, add the disputed input, and compare the old and new behavior against that contract.

**Exception:** reproduction can require inaccessible production data, hardware, or timing. Use the best available trace or focused experiment, state its limit, and identify the missing evidence. Do not fabricate a reproduction or block a harmless edit on unrelated infrastructure.

## Fidelity and maintenance cost

**Do:** choose the smallest reliable check that can detect the failure. Use pure/unit tests for domain rules, real adapter/database checks for integration semantics, and a few end-to-end checks for critical journeys. Consider speed, maintainability, resource use, reliability, and fidelity together.
**Do not:** impose fixed test ratios or coverage quotas, or mock away the behavior at issue.

Bad: test a lost-update fix by mocking `save()` and asserting one call.
Good: exercise the relevant transaction/concurrency behavior against the database or a validated equivalent, while keeping pure calculations in small deterministic tests.

Bad: snapshot private helper call order, then rewrite snapshots after every behavior-preserving refactor.
Good: assert the public result, failure semantics, and meaningful side effects. Use real implementations when practical, validated fakes when needed, and mocks for specific otherwise hard-to-trigger conditions.

**Exception:** an injected timeout or provider failure can justify a mock. Contract-check a maintained fake where drift would conceal defects; do not demand live external calls in every test.

## Choose additional techniques by the risk

**Do:** use property tests for invariants over varied inputs, fuzzing for parsers/untrusted formats, concurrency tests for ordering/atomicity, and mutation testing when ordinary tests fail to discriminate incorrect behavior.
**Do not:** install all of these techniques merely because code was written by an agent.

Bad: add an integration-test framework to a simple Bash file renamer.
Good: check quoting, spaces, collisions, exit status, and a representative temporary-directory run using the project's existing tools.

**Exception:** a small script with destructive effects needs stronger verification of those effects; keep the implementation simple while checking the actual risk.

## User behavior and performance

**Do:** verify the changed interaction and relevant accessibility behavior for user-facing work. Support performance claims with a representative workload, baseline, environment, and observed result.
**Do not:** infer usability from compilation, or claim a speedup from code appearance or one noisy timing.

Bad: a keyboard-navigation change passes typecheck and is declared verified.
Good: exercise the affected focus path and supported controls, using available automated checks plus a targeted interaction check where required.

Bad: replace a readable implementation because it "looks slow."
Good: measure the affected path, identify the bottleneck, and compare behavior and resource cost after the change.

**Exception:** a security or correctness fix can proceed without a benchmark when it makes no performance claim. State an unavailable runtime check as an evidence gap.

## Completion evidence

**Do:** report checks actually run, their result, relevant commit/artifact/environment, and remaining limits. Rerun checks affected by subsequent edits and preserve required integration gates.
**Do not:** present a worker's focused tests as whole-repository validation, or a passing CI run on an older head as proof for the new head.

Bad: "All verified" after editing code following the test run.
Good: rerun affected checks and report that evidence; distinguish implemented, locally verified, CI verified, deployed, and observed states.

**Exception:** documentation or mechanical changes need only relevant validation plus required gates; do not create tests that merely restate the edit.

Sources: [Google SMURF testing tradeoffs](https://testing.googleblog.com/2024/10/smurf-beyond-test-pyramid.html), [test fidelity and doubles](https://testing.googleblog.com/2024/02/increase-test-fidelity-by-avoiding-mocks.html), and [Software Engineering at Google on unit tests](https://abseil.io/resources/swe-book/html/ch12.html). These support contextual test selection, not universal test quotas.
