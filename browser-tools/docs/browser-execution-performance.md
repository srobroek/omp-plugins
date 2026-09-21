# browser-tools deterministic execution contract

Status: Implemented; the benchmark program remains an evaluation protocol
Scope: `browser-tools/extensions/**` and its package documentation
Baseline: `@srobroek/browser-tools` 0.3.8 with `puppeteer-core` 25.3.0
Owner: browser-tools maintainers

## Decision

The implementation adds one deterministic, typed plan executor for browser-tools-owned Firefox-family sessions. The executor runs a bounded sequence inside one tool invocation.
It serializes mutations per tab. It resolves targets against the current document. It returns bounded per-step results.

This plan excludes the following systems:

- CDP code;
- an MCP server;
- an in-tool model loop;
- changes to OMP's built-in Chromium relay.

Those systems have different owners.

The implementation also adds a page-local cursor visualization after verifying the pinned 25.3.0 WebDriver BiDi preload interface.
It installs the preload once per page and treats all visualization state as decorative and untrusted.

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

## Implemented surfaces

`browser-tools/extensions/headed-browser-tools.ts` registers five tools:

- `headed_session`;
- `headed_nav`;
- `headed_read`;
- `headed_act`;
- `headed_plan`.

The standalone tools and `headed_plan` call the shared policy-aware primitives in `browser-tools/extensions/lib/operations.ts`.
The plan runs ordered navigation, read, and action steps in one outer tool call.

`browser-tools/extensions/lib/session.ts` owns live `Browser` and `Page` values, tab selection, selector refs, network events, warnings, profile state, tab generations, and document epochs.
Top-level navigation increments the document epoch and clears selector refs before later operations can resolve them.
The shared tab lock serializes standalone mutations and plan steps against the same selected page identity.
A plan takes one hold on that lock. Its steps re-enter the hold, so the plan owns the tab from its first step through its last.

`applyPagePolicy` enables Puppeteer interception for requests governed by the configured policy.
It resolves each request once before invoking the asynchronous audit sink, so audit persistence cannot stall navigation.

`withPageTimeout` closes the isolated session and its owned local or remote browser resources when an operation outlives its timeout.
This prevents a timed-out operation from mutating the page after its lock has been released.

The package pins `puppeteer-core` 25.3.0. Current public Puppeteer documentation targets a newer version. Every depended-on interface requires tagged-source or runtime verification against 25.3.0.

## Scope

### Included

- shared policy-aware operation primitives;
- one FIFO writer chain per session tab with a 30-second acquisition bound;
- one re-entrant plan hold on that chain, taken once per plan and released once;
- fixed plan tab identity and top-level-navigation ref invalidation;
- one `headed_plan` tool with 20-step and inline-output limits;
- fail-fast execution and host cancellation checks;
- bounded plan audit summaries;
- page-local cursor preload and driver-side geometry checks;
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

## Pinned compatibility evidence

The package pins `puppeteer-core` 25.3.0.
Focused tests cover:

- preload installation and overlay deduplication;
- target geometry and movement rejection;
- cancellation and request resolution;
- plan serialization.

A real Firefox/BiDi smoke run verifies:

- preload and cleanup;
- the visible click path;
- ordered plan execution.

## Deep module and interface

`browser-tools/extensions/lib/plan.ts` owns plan validation and execution.
Existing tool handlers and `headed_plan` call shared operation primitives.
No registered tool calls another registered tool.

The host schema accepts plan-step fields without stripping unknown keys.
`validatePlan` rejects unknown fields.
It validates every step before session lookup or browser work.

The plan contract is:

- one to 20 ordered steps;
- `nav`, `read`, and `act` step kinds;
- the standalone operation names and parameters;
- the standalone policy and timeouts;
- the standalone cursor behavior;
- the standalone tab lock, taken once by the plan and held across every step;
- one selected tab identity fixed at plan start;
- stop on the first failure or cancellation;

The plan excludes:

- tab creation, switching, and closure;
- arbitrary page evaluation;
- session lifecycle steps.

Each executed step returns:

- its index;
- its kind and operation;
- elapsed milliseconds;
- success state.
A failed step also returns a sanitized error category and a message capped at 300 characters.
Later steps are absent because they did not execute.

Read results use character-counted inline limits:

- 8,192 characters per step;
- 65,536 characters across the plan.

An oversized read result becomes truncated JSON text and sets `truncated: true`.
Screenshot and PDF reads return their session-scoped artifact paths instead of inline binary payloads.
The limits are fixed; the request exposes no aggregate-output or total-timeout override.

## Serialization and cancellation

Operations use one FIFO writer chain per session tab.
The chain serializes:

- navigation;
- reads;
- actions;
- cursor visualization.
Standalone tools and plans use the same chain.

A plan acquires one hold before its first step and keeps it until its last step ends.
Each step re-enters that hold instead of queueing behind the plan that owns the tab.
A standalone call queued after the plan acquired the tab runs after the plan's last step, never between two steps.
Acquiring, re-entering, and releasing a tab each record session activity, so a plan of short steps does not age into the idle sweep.
A session with a held tab is skipped by the idle sweep entirely, so an operation allowed to wait longer than `idleCloseSec` is not closed underneath itself.

A turn holds the chain of every tab it touches, including one it selects part-way through.
`newTab` takes the created tab's hold before publishing the selection, so the created tab's policy and first navigation finish before any queued call reaches it.
`closeTab` takes the hold of the tab it closes, so a call already working on that tab finishes first.
Those two nested acquisitions cannot deadlock: a turn reaches them only while it holds the currently selected tab, at most one turn holds that, and a turn holding any other tab is rejected as stale beforehand.

A caller waits at most 30 seconds to acquire an occupied tab.
Expiry returns the `tab busy` category without starting that caller's browser work.
The plan pins both the selected tab ID and its `Page` object; replacement or selection changes return `stale tab`.

A session is marked closing before anything a close awaits, including the close tool's own audit record: explicit close, idle close, and page-timeout containment all mark it first, and the teardown then runs whatever that record does.
A session has one teardown. Ownership is taken synchronously, so a caller holding the session adopts the running teardown and its result instead of looking the session up again and reporting it as unknown; the browser, the remote resources, and the profile are cleaned up once, and the reported reason names whichever path started it.
An id no session answers to is still `unknown session`, which is what a caller naming a session that is already gone hears.
A queued caller is woken by that mark instead of by the holder's release, and a caller arriving afterwards is refused, both with the `unknown session` category.
A woken caller hands its queue slot to the holder it waited on, so the callers behind it keep their order.

Cancellation is checked before the plan acquires the tab, again the moment it holds the tab, and again before every step.
The middle check covers the queue wait, where a host cancellation usually lands: a plan cancelled while queued writes no plan record, runs no step, and reports `cancelled` with no executed steps.
Each operation rechecks it once it holds or re-enters the tab.
Target-bearing actions also recheck cancellation after cursor visualization and before dispatching the action.
The first failure or cancellation ends the plan, and no later step starts.

## Document and target validity

A snapshot stores CSS-path refs under the tab that produced them.
Top-level `framenavigated` events clear that tab's refs, including navigation caused by an action.
An action resolves its selector or ref to a fresh driver handle immediately before use and disposes that handle afterwards.

Cursor visualization adds a geometry check for target-bearing actions:

1. Resolve and scroll the target through Puppeteer.
2. Read its driver-side bounding box.
3. Render the decorative cursor command.
4. Read the same handle's bounding box again.
5. Accept a center movement of at most 4 CSS pixels with overlapping boxes.
6. Otherwise dispose the handle, resolve once more, and repeat.
7. If the second position is also unstable, return `target_moved` without acting.

The implementation does not retain an `ElementHandle` across operations.
Take a fresh snapshot after document or component changes; CSS refs are invalidated automatically only on top-level navigation.

## Policy, audit, and redaction

Each plan step uses the same policy and feature gates as its standalone operation.
These configuration values remain fixed throughout a plan:

- executable paths;
- SSH settings;
- profiles and cookie domains;
- domain rules and feature gates.

Arbitrary page evaluation and tab-set mutations stay in standalone tools.

Explicit `goto` operations validate scheme and domain before navigation.
Page-driven top-level requests use the same domain policy through interception.
The request is continued or aborted exactly once before its audit sink runs, so audit persistence cannot hold the request open.

The plan writes a bounded start and completion summary to the existing audit log.
Those summaries contain operation metadata, not page payloads.
Tool results pass through the existing secret redactor before delivery.

## Failure and timeout behavior

The entire plan is validated before session lookup or browser work.
Completed browser actions are not rolled back.

Every driver operation uses the existing bounded page timeout.
When an operation exceeds that timeout, browser-tools closes the isolated session and terminates resources it launched.
This containment prevents the unresolved operation from mutating the page after the tab lock is released.

The public result uses the implementation's small error vocabulary:

- `invalid request`;
- `unknown session`;
- `session timeout`;
- `launch failed`;
- `target_moved`;
- `tab busy`;
- `cancelled`;
- `stale tab`;
- `operation failed`.

## Cursor preload

The cursor is decorative.
These decisions use only driver state:

- plan execution;
- target selection;
- geometry checks;
- policy;
- action success.

Page-reported cursor state remains decorative.
Preload or command failure disables visualization, records one warning, and continues the browser action.

`registerPage` installs one versioned `evaluateOnNewDocument` preload and bootstraps the already-loaded document.
A version guard prevents duplicate roots and listeners.
The overlay is fixed, `pointer-events: none`, and hidden from accessibility APIs.

Supported modes:

| Mode | Behavior |
|---|---|
| `off` | No page visualization |
| `instant` | Move and pulse without a travel delay |
| `animated` | Bounded cursor travel before the pulse |

Headless sessions resolve `auto` to `off`; visible sessions resolve it to `animated`.
Reduced-motion and hidden-document state remove animation delay.
Cleanup hides the overlay:

- after completion or failure;
- after cancellation;
- during navigation.

Cursors in sibling tabs retain separate preload and document-epoch state.

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

The initial benchmark uses three arms:

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

Initial acceptance:

- The eight-step plan uses one outer tool invocation rather than eight.
- The compact read uses one page evaluation rather than eight and returns equivalent values.
- Report measured latency without a preset percentage win.
- Every intercepted request receives one terminal resolution.
- A non-resolving audit sink does not delay request-resolution dispatch; report measured scheduling overhead separately.

Deferred benchmarks may cover:

- independent-page concurrency;
- warm reuse;
- resource blocking;
- cache policy;
- static HTTP routing;
- larger percentile programs.

These benchmarks do not block the initial executor.

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

This upstream proposal leaves planner fan-out outside browser-tools. A safe coordinator belongs in OMP orchestration and uses three planes:

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
