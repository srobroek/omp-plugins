# browser-tools deterministic execution performance plan

Status: Proposed
Scope: `browser-tools/extensions/**` and its package documentation
Baseline: `@srobroek/browser-tools` 0.3.8 with `puppeteer-core` 25.3.0
Owner: browser-tools maintainers

## Decision

Add one deterministic, typed plan executor for browser-tools-owned Firefox-family sessions. The executor runs a bounded sequence inside one tool invocation.
It serializes mutations per tab. It resolves targets against the current document. It returns bounded per-step results.

This plan excludes the following systems:

- CDP code;
- an MCP server;
- an in-tool model loop;
- changes to OMP's built-in Chromium relay.

Those systems have different owners.

Add optional page-local cursor visualization only if a pinned 25.3.0 WebDriver BiDi probe proves the preload interface.
Install the preload once per page. Treat all visualization state as decorative and untrusted.

## Why batching helps

Browser automation has five latency layers:

1. model queueing and generation;
2. model-to-tool or MCP transport;
3. extension processing:
   - validation;
   - policy;
   - audit;
   - queueing;
4. Puppeteer protocol commands and events;
5. page processing:
   - JavaScript;
   - layout;
   - paint;
   - network;
   - application readiness.

A deterministic plan guarantees fewer model turns and outer tool calls. It does not guarantee less protocol or page work.

For $N$ steps:

$$
T_{separate}=\sum_{i=1}^{N}(T_{model,i}+T_{tool,i}+T_{policy,i}+T_{protocol,i}+T_{page,i}+T_{audit,i})
$$

$$
T_{plan}=T_{model}+T_{tool}(N)+T_{validate}(N)+T_{lock}+\sum_{i=1}^{N}(T_{policy,i}+T_{protocol,i}+T_{page,i}+T_{audit,i})+T_{progress}
$$

The only guaranteed savings are $N-1$ model turns and $N-1$ outer transports. Compact in-page projections can separately reduce protocol commands when several related DOM reads become one `page.evaluate`.

`Promise.all` is parallel dispatch, not batching. It sends the same protocol commands and is safe only for independent work.

## Current implementation

`browser-tools/extensions/headed-browser-tools.ts` registers the following tools:

- `headed_session`;
- `headed_nav`;
- `headed_read`;
- `headed_act`.

Their handlers invoke Puppeteer directly. A deterministic sequence therefore requires one outer call per operation.

`browser-tools/extensions/lib/session.ts` owns live `Browser` and `Page` values, tab selection, selector refs, network events, warnings, and profile state. It has no tab writer lock, document epoch, or snapshot identity.

`domSnapshot` creates CSS-path refs. `targetElement` resolves the selector later. Navigation or re-render can therefore make a ref stale or resolve it to a different element.

`applyPagePolicy` enables Puppeteer interception for every request. Puppeteer documents that every intercepted request stalls until it is continued, responded to, or aborted. The allowed main-frame path awaits an audit write before continuing. No interception handler may await unbounded I/O.

`withPageTimeout` can close or kill an entire session because an unresolved operation may complete after timeout. That blast radius is inappropriate for every profile mode and must become ownership-aware before plans ship.

The package pins `puppeteer-core` 25.3.0. Current public Puppeteer documentation targets a newer version. Every depended-on interface requires tagged-source or runtime verification against 25.3.0.

## Scope

### Included

- shared policy-aware operation primitives;
- a per-tab writer lock and bounded queue;
- tab and document epochs;
- pull-time semantic target revalidation;
- one `headed_plan` tool;
- bounded results;
- progress;
- cancellation;
- audit context;
- optional page-local cursor preload after compatibility proof;
- focused benchmark fixtures and instrumentation;
- existing standalone tool compatibility.

### Excluded

- OMP built-in Chromium browser and relay changes;
- `chrome-devtools-mcp` changes;
- CDP sessions;
- Overlay implementation;
- Fetch implementation;
- Runtime implementation;
- MCP progress translation or MCP Tasks;
- speculative or standby model execution;
- arbitrary JavaScript plan steps;
- session launch inside plans;
- session close inside plans;
- profile changes inside plans;
- cookie grants inside plans;
- SSH settings inside plans;
- static HTTP routing, browser pooling, and new production concurrency defaults.

## Pinned-interface preflight

Before implementation, record a table for each depended-on Puppeteer operation:

| Interface | 25.3.0 tagged source | Firefox/BiDi runtime probe | Required behavior |
|---|---|---|---|
| `Page.evaluateOnNewDocument` or BiDi preload equivalent | Required | Required | Runs once in each new top-level document |
| `Page.waitForNavigation` | Required | Required | Wait is armed before the initiating click |
| locator or element click | Required | Required | Visibility and geometry behavior is known |
| request interception | Required | Required | Every paused request reaches one resolution |
| abortable waits | Required | Required | Cancellation support is documented per operation |

A failed or unavailable preload probe removes cursor preload from this proposal. The executor does not emulate unverified support.

## Deep module and interface

Create `browser-tools/extensions/lib/plan.ts` as the deep `BrowserPlanExecutor` module. Existing tool handlers and `headed_plan` call shared operation primitives; no registered tool calls another registered tool.

```ts
interface BrowserPlanRequest {
  sessionId: string;
  tabId?: string;
  steps: readonly BrowserPlanStep[];
  failurePolicy?: "stop" | "continue";
  totalTimeoutMs?: number;
  maxAggregateOutputBytes?: number;
  visualization?: VisualizationPolicy;
}

interface BrowserPlanExecutor {
  execute(
    request: BrowserPlanRequest,
    context: {
      ownerToken: string;
      signal: AbortSignal;
      onProgress(update: PlanProgress): void;
    },
  ): Promise<BrowserPlanResult>;
}
```

Use closed discriminated unions for request steps and results. Reuse existing operation names and parameter meanings. Reject unknown fields.

```ts
type PlanStepOutput =
  | { kind: "none"; bytes: 0 }
  | { kind: "summary"; bytes: number; url?: string; tabId: string }
  | { kind: "text"; bytes: number; text: string; truncated: boolean }
  | { kind: "snapshot"; bytes: number; snapshotId: string; refs: readonly SnapshotRef[]; truncated: boolean }
  | { kind: "artifact"; bytes: number; path: string; mediaType: string; artifactBytes: number };
```

Every output variant passes runtime schema validation. Every output variant passes redaction. Every output variant receives post-redaction byte measurement.

The following payloads return scoped artifact references rather than plan-result base64:

- screenshots;
- PDFs;
- traces;
- large HTML.

Initial limits:

- 1 to 16 steps;
- `1s` to `300s` per step, matching existing bounds;
- 5 minutes total;
- 64 KiB hard inline-output limit per step;
- 512 KiB default aggregate output limit;
- 1 MiB maximum permitted aggregate output limit.

`maxAggregateOutputBytes` sets the aggregate limit. Reject values outside 1 byte to 1 MiB. Truncate text and snapshot outputs at the smaller of the per-step limit or remaining aggregate allowance. Set `truncated: true` when truncation occurs. Return `output_limit` before appending any other output variant that would exceed either limit. Artifact payload bytes do not count toward these limits; the redacted artifact reference does.

Reject a plan when its full approval rendering exceeds the host approval-prompt bound. Show these fields for each step:

- ordinal;
- operation;
- target or destination domain;
- effect class.

Do not truncate hidden steps from the view.

Do not add an idempotency key until replay scope, retention, and process-loss semantics have a separate design.

## Lock and queue contract

Use one reentrant writer lock per `(sessionId, tabId)`.

- The outer tool entry point acquires the lock with an opaque owner token.
- Internal operation primitives accept that token and never reacquire the lock.
- The default acquisition timeout is 30 seconds.
- A timeout returns `tab_busy` with `retryable: true` and performs no browser work.
- The queue is FIFO and holds at most eight waiters per tab.
- A ninth waiter is rejected immediately as `tab_busy`.
- Cancellation removes a queued waiter without changing order for remaining waiters.
- Navigation holds the writer lock.
- Actions hold the writer lock.
- Tab mutation holds the writer lock.
- Visualization holds the writer lock.
- Ordinary tools use the same lock as plans.

Read concurrency defaults to one for WebDriver BiDi. A later benchmark may raise a fixed configured cap. If concurrent reads are enabled, each read must revalidate the document epoch after completion. Discard the entire read group when any epoch changes.

An active lock owner refreshes session activity so the idle sweep cannot close the session. The lock does not own browser destruction.

## Document and target validity

Track this state per tab:

```ts
interface TabEpoch {
  tabGeneration: number;
  documentEpoch: number;
  sameDocumentEpoch: number;
}
```

Increment `documentEpoch` for top-level document replacement. Increment `sameDocumentEpoch` for hash and History API transitions. Increment `tabGeneration` when the tab closes, is replaced, or changes ownership.

Do not install a MutationObserver for correctness. At action time, recompute the target's semantic fingerprint and compare it with the snapshot fingerprint. The fingerprint includes the tab and document epochs, role, normalized accessible name, relevant state, frame identity, visibility, and conservative structure.

Before every action:

1. Verify the lock owner.
2. Verify tab generation and document epochs.
3. Resolve a fresh target.
4. Find exactly one connected, visible semantic match.
5. Compare the current fingerprint with the snapshot fingerprint.
6. Read final geometry immediately before the pointer action.
7. Reject targets without silent remapping when they are:
   - stale;
   - detached;
   - hidden;
   - moved;
   - ambiguous.

Do not retain the following handles or identifiers across navigation:

- `ElementHandle`;
- `JSHandle`;
- BiDi remote references;
- execution contexts;
- CDP identifiers;
- MCP UIDs.

For a click expected to navigate, arm the wait before dispatch:

```ts
const [response] = await Promise.all([
  page.waitForNavigation(options),
  locator.click(),
]);
```

Declare an expected URL, document transition, or semantic postcondition for each step. Do not wait for navigation after every click. Verify both the URL and application state for same-document transitions because they may return no main response.

## Policy, audit, and redaction

Every step uses the same policy as its standalone operation. The policy covers:

- domain;
- scheme;
- feature;
- profile;
- cookie;
- redaction.

Enumerate and test the following cases:

- HTTP(S)-only navigation;
- allowlist and denylist decisions;
- redirects;
- page-driven top-level navigation;
- downloads;
- form submission;
- password entry;
- file upload;
- evaluation;
- cookie value exposure;
- secret-shaped output redaction.

A plan cannot set the following values or controls:

- driver paths;
- executable paths;
- SSH values;
- profile roots;
- cookie domains;
- domain rules;
- feature gates.

Audit records may include these optional fields:

- `planId`;
- `stepId`;
- ordinal;
- outcome.

Preserve existing allow and block decisions. Record the following outcomes separately from policy approval:

- completion;
- failure;
- cancellation;
- audit warnings.

The in-path audit write must complete within `250ms`. In the existing best-effort audit mode, continue or abort on timeout according to the already-computed policy decision. Enqueue the redacted audit record synchronously and add a counted warning. Limit the fallback queue to 64 records per session. On overflow, discard the oldest record and add another counted warning.

At each step boundary, schedule one background flush if none is active. Do not await that flush from the plan or interception path. Bound every queued write to `250ms` and retain failed records for the next boundary.

A future fail-closed audit mode requires its own explicit policy. That mode is outside this proposal.

Before every `continue` or `abort`, check interception resolution synchronously. Re-check after any await. A request receives exactly one terminal resolution.

The current interception catch can continue after an unexpected policy-handler failure. Phase 1 must preserve documented behavior, expose a warning, and add a separate decision before claiming fail-closed navigation enforcement.

## Failure, timeout, and cancellation

Validate the whole plan before effects. Default `failurePolicy` to `stop`.

Check cancellation at these points:

- before every step;
- after every awaited browser operation;
- after every awaited audit operation.

No later step starts after any of the following:

- cancellation;
- timeout;
- browser disconnect;
- lock loss.

Use ownership-aware containment for an uninterruptible timed-out operation:

- For an owned empty or throwaway profile, close the session when late mutation cannot otherwise be contained.
- For a headed profile-aware session, close the affected tab first.
- Increment the affected tab's generation.
- Preserve sibling tabs.
- Kill the whole session only when the affected tab cannot be closed or the browser connection is unhealthy.

Return the containment action and whether retry is safe. Do not retry a non-idempotent action after an unknown outcome.

Required error categories:

- `invalid_request`;
- `tab_busy`;
- `stale_target`;
- `target_moved`;
- `policy_blocked`;
- `timeout`;
- `cancelled`;
- `browser_disconnected`;
- `audit_unavailable`;
- `operation_failed`;
- `output_limit`;

The executor does not roll back completed browser actions or external side effects. Those effects remain completed.

## Progress

Use the existing OMP extension update callback as a best-effort host-local channel. This proposal makes no MCP progress claim.

Emit at most one update per completed step. Each update must include:

- plan ID;
- step ID;
- ordinal;
- total steps;
- status;
- elapsed time.

Each update must exclude:

- page text;
- query strings;
- cookie values;
- field values;
- raw errors.

No update arrives after the terminal result. Progress failure does not block browser work.

## Optional cursor preload

### Trust and fallback

Visualization is decorative and untrusted. Executor behavior must not depend on preload state or a value returned by page script. This restriction covers:

- executor decisions;
- epoch checks;
- geometry validation;
- target fingerprints;
- policy results;
- postconditions.

If preload or current-document bootstrap fails, set visualization to `off`. Emit one counted warning and continue the browser action. Page script may suppress, imitate, or alter the cursor without gaining browser capability.

### Installation

After the pinned-interface preflight passes, add a fixed versioned preload during `registerPage`. Store its registration identifier.
Install the preload once. Use a global version guard to prevent duplicate roots and listeners.
Bootstrap the already-loaded document once when visualization is enabled.

The preload accepts compact data only:

```ts
interface VisualCommand {
  version: 1;
  actionId: string;
  kind: "move" | "pulse" | "hide";
  target: { x: number; y: number };
  durationMs: number;
  documentEpoch: number;
}
```

It renders a fixed, `pointer-events: none`, accessibility-hidden overlay. A closed shadow root reduces style collisions but does not provide integrity.

### Sequence

1. Resolve and scroll the target into the visual viewport.
2. Read geometry through the trusted driver.
3. Send the visual command.
4. At the animation endpoint, re-resolve the target and read driver geometry again.
5. Verify overlap and a center delta of at most 4 CSS pixels.
6. If the target moved, re-resolve and re-animate once.
7. After a second movement, return `target_moved` without clicking.
8. Pulse, click, and clean up on completion, failure, cancellation, or navigation.

Use visual-viewport CSS pixels for all coordinate values. Do not mix them with:

- screenshot coordinates;
- device-pixel coordinates;
- layout-viewport coordinates.

Only driver-side bookkeeping may overlap cursor motion. Page reads must not run under the same writer lock during animation.

Modes:

| Mode | Behavior | Default |
|---|---|---|
| `off` | No page visualization | Headless and unattended sessions |
| `instant` | Pulse without travel delay | Debugging |
| `animated` | Bounded cursor motion | Explicit user-visible sessions |

Respect reduced-motion and hidden-page state. Those states use `instant`. Animation has a hard deadline and never blocks cancellation or teardown.

## Minimum benchmark program

Use one deterministic local fixture with:

- cross-document navigation;
- same-document History API navigation;
- one target-replacing re-render;
- child frames;
- configurable request count and delay;
- allowed and denied redirects;
- a non-resolving audit sink;
- secret canaries;
- fixed viewport and device scale factor.

Pin the following benchmark inputs:

- browser build;
- Puppeteer version;
- protocol packages;
- profile mode;
- cache state;
- viewport;
- machine;
- machine-load envelope.

Phase 0 runs only three arms:

1. eight standalone read calls versus one eight-step plan;
2. eight serial DOM reads versus one compact evaluation returning equivalent data;
3. interception behavior:
   - disabled where policy permits;
   - pass-through;
   - domain-filtered;
   - a non-resolving audit sink.

For each arm, discard 20 warm-up iterations and collect 200 measured paired iterations. Report p50 and p95 with bootstrap 95% confidence intervals.
Mark an arm inconclusive when relative confidence-interval width exceeds 10% after 200 iterations or the 30-minute arm budget expires.

Record only values observable in this repository:

- extension entry-to-result latency;
- validation and lock wait;
- policy and audit latency;
- protocol command count and response time where Puppeteer exposes it;
- request pause-to-resolution;
- page operation duration;
- output bytes;
- timeout, stale-target, and unresolved-request counts.

Phase 0 acceptance:

- The eight-step plan uses one outer tool invocation rather than eight.
- The compact read uses one page evaluation rather than eight and returns equivalent values.
- Report measured latency without a preset percentage win.
- Every intercepted request receives one terminal resolution.
- The non-resolving audit sink cannot stall navigation beyond the `250ms` audit bound plus measured scheduling error.

Deferred benchmarks may cover:

- independent-page concurrency;
- warm reuse;
- resource blocking;
- cache policy;
- static HTTP routing;
- larger percentile programs.

These benchmarks do not block the initial executor.

## Integration plan

### Phase 0: compatibility and measurement

Create the pinned-interface table and runtime probes. Add the deterministic fixture and the three minimum benchmark arms.

Acceptance: every depended-on interface is verified or removed; each arm completes within its budget and reports reproducible attribution.

### Phase 1: shared operation primitives

Extract the following policy-aware operation primitives from `headed-browser-tools.ts`:

- navigation;
- read;
- action;
- target resolution;
- timeout;
- redaction;
- audit;
- result shaping.

Keep the following existing behavior:

- tool names;
- schemas;
- approvals;
- registration tests;
- observable behavior.

Add the following safeguards and test:

- the `250ms` audit bound;
- queued fallback;
- exactly-once interception guards;
- a never-resolving audit-sink test.

Acceptance requires the following:

- existing tests remain;
- standalone operations produce equivalent results and policy decisions;
- no registered tool invokes another registered tool.

### Phase 2: tab state and serialization

Extend `HeadedSession` with the following per-tab capabilities:

- epochs;
- snapshot identities;
- writer locks;
- bounded queues;
- active-operation leases.

Invalidate refs on the following changes:

- document changes;
- history changes;
- tab-generation changes;
- pull-time fingerprint changes.

Acceptance requires observable-operation tests for:

- lock timeout;
- queue bound;
- cancellation;
- reentrancy;
- idle-sweep;
- competing caller;
- stale refs.

### Phase 3: deterministic `headed_plan`

Register one write-approved `headed_plan` backed by `BrowserPlanExecutor`. Add the following capabilities:

- closed schemas;
- limits;
- approval rendering;
- fail-fast behavior;
- cancellation;
- bounded outputs;
- progress;
- per-step audit context.

Acceptance requires the following:

- a ten-step plan uses one outer invocation;
- the plan executes in order;
- the plan preserves each enumerated policy gate;
- the plan returns typed ordered outcomes without browser-native handles.

### Phase 4: optional cursor visualization

Proceed only after Phase 0 verifies preload support on the pinned Firefox/BiDi path. Add the following capabilities:

- one versioned preload per page;
- current-document bootstrap;
- `off`, `instant`, and `animated` modes;
- driver-side geometry validation;
- one bounded reposition;
- cleanup.

Acceptance requires all of the following:

- preload failure degrades to `off`;
- repeated setup creates one overlay;
- sibling tabs remain independent;
- visualization never influences action correctness;
- geometry differs by no more than 4 CSS pixels before click;
- target movement cancels after one retry.

### Phase 5: benchmark-gated throughput

Benchmark read concurrency, interception refinements, and warm owned-session reuse separately. Keep WebDriver BiDi read concurrency at one until evidence supports a fixed higher cap.

Acceptance requires all of the following:

- an enabled optimization has a pinned benchmark;
- no policy regression occurs;
- no state leak occurs;
- an explicit rollback to the prior default exists.

## Required behavioral tests

Retain the existing tests for:

- registration;
- schema;
- approval;
- router.

Add tests for the following:

- full-plan validation before effects;
- ordered execution and typed bounded outputs;
- approval rendering and prompt-bound rejection;
- each enumerated policy and feature gate;
- allowed and denied redirects;
- atomic click-navigation synchronization;
- pull-time fingerprint mismatch after each of these changes:
  - document change;
  - history change;
  - re-render;
  - tab change.
- writer behavior for each of the following:
  - reentrancy;
  - FIFO queueing;
  - queue rejection;
  - lock timeout.
- ordinary-tool and plan non-interleaving;
- cancellation between steps and during an uninterruptible operation;
- tab-scoped timeout containment and sibling-tab survival;
- no observed late mutation across a stated trial count, with the upper confidence bound reported;
- progress ordering, terminal cutoff, and redaction;
- audit behavior for each of the following:
  - timeout;
  - queued fallback;
  - warning;
  - flush;
  - exactly-once resolution.
- preload behavior for each of the following:
  - compatibility;
  - installation;
  - deduplication;
  - failure fallback;
  - target movement;
  - reduced motion;
  - hidden page;
  - cleanup.
- secret canaries in known redaction categories.

Canaries detect regressions in known categories only. They do not prove sound redaction for arbitrary web content.

## Upstream proposals

This non-normative section records requests and evaluation guidance for other owners. It defines no implementation acceptance criteria for this repository.

### OMP built-in Chromium browser

Request an equivalent deterministic plan interface from the OMP owner. The interface reuses one page-scoped CDP session. It exposes tab and document epoch validation.
The following components belong there rather than in browser-tools:

- CDP Overlay;
- Runtime;
- DOM;
- Fetch;
- `Page.addScriptToEvaluateOnNewDocument`.

Request fresh node resolution from the CDP owner after `DOM.documentUpdated` and execution-context changes. Use `Overlay.highlightNode` with a current node or object. Call `Overlay.hideHighlight` during cleanup. Rectangle highlighting needs explicit device-pixel handling.

### chrome-devtools-mcp

Request a bounded multi-step plan tool or a server-validated snapshot-version token from the server owner. Before that capability exists, the recommended caller behavior uses:

- explicit `pageId`;
- the latest snapshot UID;
- sequential mutations;
- fresh snapshots after navigation.

An OMP extension cannot enforce epochs inside an unmodified external server.

MCP progress and Tasks need a real server boundary. They also need:

- capability negotiation;
- cancellation;
- bounded retained results;
- principal-bound task IDs;
- TTL;
- process-loss semantics.

browser-tools does not provide that boundary.

### Speculative and standby agents

This proposal leaves planner fan-out outside browser-tools. A safe coordinator belongs in OMP orchestration and uses three planes:

- observation;
- reasoning;
- single-writer commit.

Planners may receive immutable data-only snapshots and return candidates. They receive none of the following capabilities:

- browser;
- MCP;
- filesystem;
- network;
- DOM;
- protocol.

A safe coordinator re-observes and validates the following before one action:

- tab identity;
- document epoch;
- target fingerprint;
- policy;
- authorization.

No sound redaction exists for arbitrary DOM text. A safe design does not fan out arbitrary page content until a separate redaction design is approved. Known-category canaries cannot establish soundness.

After that prerequisite is resolved, an evaluation should compare one planner with two diverse planners on at least 200 paired tasks. It should report confidence intervals for success and latency differences. It should report:

- duplicated tokens;
- cost;
- privacy exposure;
- cancellation;
- stale-candidate rate;
- postcondition success.

An evaluation avoids an unjustified fixed cost multiplier as an enablement gate.

Destination-page target selection begins only after that document is observed. Agents may reason about expected postconditions while navigation is in flight, but a safe coordinator selects no live target from an unseen page. Credentialed prefetch in a user's tab remains outside this proposal because it is unsafe.

### Production browser throughput

Owned ephemeral browser systems may evaluate:

- warm process reuse;
- isolated pages or contexts;
- bounded resource-aware concurrency;
- semantic readiness;
- selective resource blocking;
- static HTTP fast paths.

For user live relays, the recommended invariants prohibit:

- automatic retirement;
- cache clearing;
- service-worker changes;
- request blocking;
- concurrent mutations.

## Rejected approaches

- unbounded `Promise.all` across tabs;
- unbounded `Promise.all` across pages;
- unbounded `Promise.all` across tools;
- unbounded `Promise.all` across agents;
- concurrent mutations against one tab;
- generic arbitrary JavaScript in plans;
- global `networkidle` waits;
- global fixed sleeps;
- blanket resource blocking;
- blanket cache disabling or service-worker bypass;
- DOM or protocol handles reused across navigation;
- automatic retirement of a user live relay;
- credentialed speculative prefetch;
- whole-session teardown when tab-scoped containment works;
- success claims based only on click dispatch or reduced tool-call count;
- removal of existing registration tests because executor tests exist.

## Sources

### Repository

- `browser-tools/README.md`
- `browser-tools/package.json`
- `browser-tools/extensions/headed-browser-tools.ts`
- `browser-tools/extensions/lib/session.ts`
- `browser-tools/extensions/lib/policy.ts`
- `browser-tools/extensions/lib/driver.ts`
- `browser-tools/extensions/tools.test.ts`

### Puppeteer and protocols

- [Puppeteer JavaScript execution guide](https://pptr.dev/guides/javascript-execution)
- <a href="https://pptr.dev/api/puppeteer.page.evaluateonnewdocument">Puppeteer <code>Page.evaluateOnNewDocument</code> method documentation</a>
- <a href="https://pptr.dev/api/puppeteer.page.waitfornavigation">Puppeteer <code>Page.waitForNavigation</code> method documentation</a>
- [Puppeteer request interception guide](https://pptr.dev/guides/network-interception)
- [Puppeteer WebDriver BiDi guide](https://pptr.dev/webdriver-bidi)
- [Puppeteer 25.3.0 `Connection.ts` source](https://raw.githubusercontent.com/puppeteer/puppeteer/refs/tags/puppeteer-v25.3.0/packages/puppeteer-core/src/cdp/Connection.ts)
- [Chrome DevTools Protocol specification](https://chromedevtools.github.io/devtools-protocol/)
- <a href="https://chromedevtools.github.io/devtools-protocol/tot/Page/">Chrome DevTools Protocol Page domain specification</a>
- [Chrome DevTools Protocol DOM.pdl source](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl)
- [Chrome DevTools Protocol Overlay.pdl source](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Overlay.pdl)
- [WebDriver BiDi specification](https://w3c.github.io/webdriver-bidi/)

### MCP and browser operations

- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)
- [MCP cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)
- [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview)
- [Chrome DevTools MCP tool reference](https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md)
- [Chrome DevTools MCP design principles](https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/design-principles.md)
- [Crawlee BrowserPool options](https://crawlee.dev/js/api/browser-pool/interface/BrowserPoolOptions.md)
- [Crawlee AutoscaledPool](https://crawlee.dev/js/api/core/class/AutoscaledPool.md)
- [Browserless best practices](https://docs.browserless.io/baas/best-practices.md)
- [Browserless batch DOM queries](https://docs.browserless.io/examples/batch-dom-queries.md)
- [Browserless waiting](https://docs.browserless.io/bap/waiting.md)
