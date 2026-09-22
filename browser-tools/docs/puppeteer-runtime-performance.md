# Puppeteer runtime performance guide

Baseline: `puppeteer-core` 25.3.0 in `browser-tools`. Public Puppeteer pages consulted here describe 25.11.0. Check the 25.3.0 tagged source and run a Firefox-family probe before relying on a version-sensitive API.

The [deterministic execution contract](./browser-execution-performance.md) owns transport analysis and the minimum benchmark program.

## Runtime boundary

Use five fields for every performance decision:

1. mechanism;
2. applicable surface;
3. identity and safety preconditions;
4. measurement;
5. claim class.

A mechanism-guaranteed result removes a known operation. A benchmark-dependent result depends on workload conditions. A safety-only control protects correctness or isolation.

### Critical path

Measure these phases separately:

```text
launch or connect
  -> browser, context, and page creation
  -> queue wait and ownership lock
  -> Puppeteer host work and protocol transport
  -> request policy, interception, and audit
  -> network, cache, service worker, and redirects
  -> renderer script, style, layout, paint, and compositor
  -> semantic readiness and postcondition
  -> page extraction and serialization
  -> host deserialization, redaction, and output transfer
```

The pinned Puppeteer 25.3.0 [CDP connection](https://raw.githubusercontent.com/puppeteer/puppeteer/refs/tags/puppeteer-v25.3.0/packages/puppeteer-core/src/cdp/Connection.ts) and [BiDi connection](https://raw.githubusercontent.com/puppeteer/puppeteer/refs/tags/puppeteer-v25.3.0/packages/puppeteer-core/src/bidi/Connection.ts) send commands independently.
Puppeteer exposes no generic protocol batch envelope.
A server plan can reduce outer calls.
An in-page projection can reduce equivalent commands.
Neither changes the protocol contract.

### Ownership boundaries

Keep these populations separate in benchmarks and defaults.

| Workload | Owner | Safe runtime controls |
| --- | --- | --- |
| Owned unauthenticated scraping | Scraper owns browser and profile. | HTTP and owned lifecycle controls. |
| Owned authenticated scraping | Scraper owns lifecycle. | One context per account. Per-identity concurrency. |
| Explicit headed Firefox/BiDi | `browser-tools` owns the BiDi session and policy. | Locks, epochs, and bounded output. |
| User-owned native Chromium/CDP relay | Native OMP/relay owner controls adoption. | Persistent sessions under relay policy. |

Safety boundaries:

- Verify equivalent fields before HTTP routing.
- Prove that blocked resources are optional.
- Keep identity state in one context.
- Probe the pinned BiDi API.
- Serialize tab mutations.
- Preserve the user-owned profile.
- Preserve the user-owned cache.
- Preserve user-owned service workers.
- Preserve user-owned focus and tabs.

`browser.disconnect()` leaves a browser and its pages alive. `browser.close()` shuts them down ([Puppeteer browser management](https://pptr.dev/guides/browser-management)). Use each operation under its lifecycle contract.

For native Chromium, the adopted profile is user-owned mutable state.
Chrome documents profile data and its separate cache directory ([Chromium user data directory](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)).
Chrome's remote-debugging policy requires a non-default `user-data-dir` for a relaunch ([remote debugging changes](https://developer.chrome.com/blog/remote-debugging-port)).
The extension relay adopts an existing profile. Its owner retains relaunch policy.

## Priority order

This order favors owned scraping. It does not set defaults for a user-owned relay.

| Priority | Control | Main effect | Claim class |
| --- | --- | --- | --- |
| P0 | Route response-complete work to HTTP | Avoid browser work. | Avoidance is guaranteed. Throughput is empirical. |
| P1 | Reuse processes and connections | Amortize startup and attach. | Setup savings are guaranteed. Total gain is empirical. |
| P2 | Use semantic readiness | End waits at the first valid condition. | Best condition is empirical. |
| P3 | Use compact projections | Replace equivalent reads with one evaluation. | Command reduction is guaranteed. Speed is empirical. |
| P4 | Remove or harden interception | Avoid paused requests. | Pause reduction is guaranteed. Total gain is empirical. |
| P5 | Bound concurrency and queueing | Stay within resource and identity limits. | Safety envelope is guaranteed. Best cap is empirical. |
| P6 | Preserve cache and service workers | Reuse local responses and app behavior. | Semantics are documented. Speed is empirical. |
| P7 | Block proven-optional resources | Remove selected network work. | Network savings are direct. Page speed is empirical. |
| P8 | Retire and escalate from evidence | Bound bloat. Add anti-bot controls only when needed. | Thresholds are empirical. |

## Workload routing: HTTP versus browser

### Use

Use a plain HTTP/HTML crawler when the response contains the required fields and links.
Avoid:

- JavaScript;
- browser storage;
- visual state;
- interaction.

Crawlee describes `CheerioCrawler` as an HTTP request plus Cheerio parsing path. It cannot execute client-side JavaScript ([Crawlee Cheerio guide](https://crawlee.dev/js/docs/guides/cheerio-crawler-guide#when-to-use-cheeriocrawler)).

Crawlee reports 500 or more pages per minute for roughly 400 KB HTML pages on 4 GB RAM and one CPU.
This is a vendor workload example.
Reproduce the payload and target rate before using the number.
Also reproduce the fields and correctness checks.

HTTP routing removes these browser phases:

- launch;
- context creation;
- protocol commands;
- renderer work;
- browser-only resources.

Use HTTP first for owned unauthenticated scraping.
Use authenticated HTTP only with an explicit endpoint contract.
Scope credentials to the origin.
Check CSRF and session binding.
Key caches by identity.

Keep browser work for client-rendered data and browser-only authentication.
Keep browser work for visual state and service-worker behavior.
Use it for storage-dependent flows and interaction.

### Measure

Compare HTTP and browser arms on one fixture. Compare equivalent result checksums. Record:

- p50, p95, and p99 task latency;
- request and result bytes;
- CPU and RSS;
- browser launches avoided;
- 4xx and 5xx outcomes;
- block and challenge outcomes;
- authentication failures.

Browser work is avoided by mechanism. Total throughput is benchmark-dependent.

## Lifecycle reuse and identity isolation

### Use

Keep a bounded set of warm browser processes for owned scraping.
Create pages or contexts according to state needs.
Puppeteer documents cookie and local-storage isolation between browser contexts ([browser management](https://pptr.dev/guides/browser-management)).
Closing a context also closes its pages.
Browserless recommends reusing a browser connection while opening multiple pages ([production best practices](https://docs.browserless.io/enterprise/docker/best-practices)).

Reuse amortizes launch and connection setup.
It also amortizes target attach and session setup.
Renderer, network, and serialization work remain.
A preload registration removes repeated installation commands.
Its script still runs in each new document and frame ([Puppeteer `evaluateOnNewDocument`](https://pptr.dev/api/puppeteer.page.evaluateonnewdocument), [`devtools-protocol` PDL](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Page.pdl)).

### Safety by surface

- **Owned scraping:** bound pages per process. Assign each context and page to one owner.
- **Authenticated scraping:** assign one context or profile to each account.
  Keep storage, proxy, and fingerprint coherent.
  Recheck login, CSRF, and OAuth state after replacement.
- **Owned Firefox/BiDi:** reuse the Puppeteer session after a 25.3.0 probe confirms support.
- **User-owned relay:** retain an adopted connection only under relay policy. Target replacement or a user switch invalidates the retained target.

### Measure

Compare these arms:

1. cold launch and connect;
2. warm process with a new page;
3. warm process with a new isolated context;
4. warm page reset.

Record setup spans, pages per process, and context count.
Record RSS/heap and p95 latency.
Record crashes and disconnects.
Record cache source and cross-identity canaries.
Setup savings are mechanism-backed.
Safe reuse count and total latency are benchmark-dependent.

## Readiness and navigation

### Choose the condition

Choose the first condition that proves the requested result.

| Result source | Readiness condition |
| --- | --- |
| Initial HTML | `domcontentloaded` or BiDi `interactive` |
| Dynamic content | Specific selector or content version |
| API-backed content | Specific response |
| Application state | Custom event or page condition |
| Broad quiescence | Network idle only when required by the page contract |

Puppeteer says `waitForNetworkIdle()` waits at least its configured idle interval.
Long-lived connections can prevent useful quiescence ([Puppeteer `waitForNetworkIdle`](https://pptr.dev/api/puppeteer.page.waitfornetworkidle)).
Browserless recommends waits that match a selector or response. It also covers event and function waits ([Browserless waiting](https://docs.browserless.io/bap/waiting.md)).
The [WebDriver BiDi navigation specification](https://w3c.github.io/webdriver-bidi/#command-browsingContext-navigate) describes document stages.
Application readiness needs an application condition.

Use a selector that proves the requested data.
A shell selector is insufficient.
Use bounded timeouts.
Record the condition that completed.
Fixed sleeps are pacing controls.

Arm navigation waits before the action that can navigate.
Puppeteer documents this pattern for the [`waitForNavigation` method](https://pptr.dev/api/puppeteer.page.waitfornavigation).
Hash and History API transitions can resolve with `null`.
Verify the URL and application state for those transitions.

`browser-tools` uses `DOMContentLoaded` as its navigation default.
It also exposes selector and text waits.
Headed actions and screenshots add visibility and focus checks.
They also add compositor and target-freshness checks.

### Measure

Record:

- time to condition;
- false-ready and partial-result rates;
- timeout rate;
- postcondition success;
- active requests at completion;
- response or `null` outcomes.

The best condition and its latency are benchmark-dependent.

## Extraction and serialization

### Use compact projections

Run one read-only page function for related reads.
Return a compact object or array.
Browserless documents one `page.evaluate()` for related remote DOM queries ([batch DOM queries](https://docs.browserless.io/examples/batch-dom-queries.md)).
Puppeteer states that the [`evaluate` method](https://pptr.dev/api/puppeteer.page.evaluate) runs in the page context and returns the resolved value.

Return required primitives and bounded records.
Full HTML and DOM nodes add work.
Screenshots and handle graphs add work.
Use `ElementHandle` or `JSHandle` for incremental or identity-dependent interaction.
Dispose handles after use.

Replacing N equivalent reads with one projection removes N-1 protocol commands and result envelopes.
Page traversal and layout remain.
JavaScript and serialization remain.
Redaction and output transfer remain.
Large projections can move the bottleneck to page CPU or serialization.

### Safety by surface

Remote relay work has the clearest transport opportunity.
Local BiDi results depend more on page CPU and serialization.

Keep the projection read-only, bounded, and redacted.
Tie it to the current document.
Re-resolve targets after navigation or document replacement.
Discard stale handles and projections.

`Promise.all()` overlaps independent commands.
It keeps the command count.
It can lower wall time toward the slowest command.
Shared state and navigation can make it unsafe.
Dialogs, target limits, and relay backpressure can also make it unsafe.
Use it for independent reads or watcher-plus-action pairs only.

### Measure

Compare serial reads, independent concurrent reads, and one projection.
Use small, medium, and large canonical outputs.
Record command count, evaluation time, and result bytes.
Record serialization and redaction time.
Record p50, p95, and p99.
Record checksum, row count, and truncation.


The command reduction is guaranteed for an equivalent rewrite. End-to-end speed is benchmark-dependent.

## Interception and resource blocking

### Request interception

Puppeteer states that request interception stalls requests until `continue()`, `respond()`, or `abort()` resolves it ([request interception](https://pptr.dev/guides/network-interception)).
Its handler guidance requires a synchronous resolution check before and after asynchronous work.

Enable interception only for a per-request policy.
Classify requests synchronously.
Bound audit work.
Resolve each request exactly once.
The current browser-tools main-frame path resolves the request before invoking the audit sink.
Audit persistence does not add navigation wait; only synchronous classification and request-resolution dispatch remain on that path.

Use this control on owned scraping and the browser-tools policy path.
Native CDP use requires the relay owner's policy.
Crawlee's browser-side blocker does not imply Firefox/BiDi support.

Preserve policy for:

- schemes;
- domains;
- redirects;
- downloads;
- forms;
- the main document.

Check resolution after every asynchronous operation. Keep audit and authorization in the path.

Measure pause-to-resolution, handler time, and audit wait.
Measure unresolved and duplicate resolutions.
Measure requests per page and cache source.
Measure navigation p95 and policy parity.
Interception pause cost is mechanism-backed.
Total improvement is benchmark-dependent.

### Resource blocking

Block one resource class at a time after a correctness canary.
Crawlee documents `blockRequests()` as browser-side URL blocking that avoids Puppeteer interception and preserves browser cache behavior ([Crawlee Puppeteer context](https://crawlee.dev/js/api/puppeteer-crawler/interface/PuppeteerCrawlingContext.md#blockRequests)).
Its `blockResources()` guidance warns about performance impact.
Browserless warns that over-blocking can trigger bot detection ([resource guidance](https://docs.browserless.com/browserql/best-practices#reject-unnecessary-resources)).

Keep the document and redirects. Preserve these resources until a canary proves they are optional:

- scripts;
- XHR and fetch;
- service-worker traffic;
- CSS and fonts;
- challenge resources.

This protects app boot and authentication.
It also protects layout, screenshots, and extraction.
Use blocking first for owned unauthenticated scraping.
Use it in an owned headed session when visual and interaction contracts allow it.
Keep it off by default in user-owned relay sessions.

Version each block rule by origin and site. Measure:

- requests and bytes by type and host;
- renderer CPU;
- time to ready;
- checksum;
- JavaScript errors;
- layout canaries;
- screenshots;
- challenge rate.

Network savings are direct. Page speed and success remain benchmark-dependent.

## Cache and service workers

Keep cache and service-worker behavior unchanged for ordinary runs.
A cache hit can avoid transfer and server work.
A service worker can serve local data and run application code.
Explicit bypass changes freshness and may change page behavior.

Puppeteer documents `Page.setCacheEnabled()`. CDP distinguishes `Network.setCacheDisabled` from `Network.setBypassServiceWorker`: the first prevents cache use; the second ignores the service worker ([Chrome DevTools Protocol Network domain](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Network.pdl)).

- **Owned scraping:** use cache-on as the control.
  Add cold and warm arms when needed.
  Add cache-disabled and service-worker-bypassed arms for freshness studies.
  Bound response caches by identity and origin. Apply TTL and byte limits.
  Crawlee warns that in-memory response caching can leak memory ([Crawlee cache responses](https://crawlee.dev/js/api/puppeteer-crawler/interface/PuppeteerCrawlingContext.md#cacheResponses)).
- **Owned Firefox/BiDi:** current Puppeteer support lists `setCacheEnabled()` as supported.
  It lists `setBypassServiceWorker()` and `reload({ignoreCache})` as unsupported over BiDi ([Puppeteer BiDi support](https://pptr.dev/webdriver-bidi)).
  Probe the repository's 25.3.0 runtime before relying on either claim.
- **User-owned relay:** preserve the user's storage, cache, and service-worker policy. A personalized response belongs to its identity.

Measure:

- response source;
- worker timing;
- request and response bytes;
- time to ready;
- freshness;
- errors;
- cross-identity leakage.

Cache and service-worker source are treatment factors. Speed and freshness remain benchmark-dependent.

## Concurrency and backpressure

Use separate bounds for:

- browser processes;
- contexts;
- pages;
- per-origin request rate;
- per-identity mutations.

Crawlee's `AutoscaledPool` uses CPU, memory, and event-loop capacity.
Its documentation warns that excessive minimum concurrency can slow or crash a crawler ([AutoscaledPool](https://crawlee.dev/js/api/core/class/AutoscaledPool.md)).
Its scaling guidance uses a request-rate cap to prevent bursts ([scaling crawlers](https://crawlee.dev/js/docs/guides/scaling-crawlers)).

Bound admission with a FIFO queue, explicit rejection, or backoff.
Use independent pages for concurrent owned scraping.
Add a per-identity cap for authenticated work.
Serialize mutations in one headed or BiDi tab.
Keep read concurrency at one until the pinned Firefox driver and document-epoch contract support more.
Follow provider and relay queue limits for native relay work.

Measure:

- desired and current concurrency;
- queue depth and wait;
- service time;
- CPU, RSS, and event-loop lag;
- crashes and OOM;
- request rate;
- 401 and 403 responses;
- 429 and 5xx responses;
- timeouts;
- canonical tasks;
- correctness.

Bounds provide a safety envelope. The throughput-optimal cap is benchmark-dependent.

## Retirement and leak control

Retirement bounds memory growth and stale listeners.
It also bounds service-worker state, crash risk, and latency drift, at the cost of launch and cache-warm work.
Crawlee exposes page-per-browser and page-count retirement.
It also exposes inactive-browser retirement and operation timeouts ([BrowserPool options](https://crawlee.dev/js/api/browser-pool/interface/BrowserPoolOptions.md)).
Browserless recommends controlled connection reuse ([best practices](https://docs.browserless.io/enterprise/docker/best-practices)).
Treat those values as reference points.

For owned scraping, retire after in-flight work completes when an operating envelope is crossed.
Use RSS and p95 drift as signals.
Also use crash rate and state canaries.
Close a page or context before retiring the process when possible.
Rehydrate the profile after replacement.
Check authentication again.

For authenticated scraping, replace an identity session after target-confirmed auth or block signals.
Diagnose generic infrastructure errors separately.
Check login, CSRF, and OAuth state after replacement.

Keep explicit headed session lifecycle.
User-owned relays retain browser and profile ownership with the relay or user.
Automatic retirement and storage reset are outside safe defaults.

Measure:

- RSS, heap, and open pages;
- age and page count;
- p95 drift;
- startup amortization;
- crashes and disconnects;
- close failures;
- identity postconditions.

Thresholds and net throughput effects are benchmark-dependent.

## Headed and relay surfaces

Headed and native-relay work adds compositor and operating-system state.
Chrome documents lifecycle states and timer throttling ([Chrome lifecycle behavior](https://developer.chrome.com/docs/web-platform/page-lifecycle-api), [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)).
A visible tab can be passive.
A hidden page can stop `requestAnimationFrame` callbacks.
`Page.bringToFront()` activates a page ([Puppeteer bringToFront](https://pptr.dev/api/puppeteer.page.bringtofront)).

### Target and focus

Adopt one target and one persistent session when ownership permits it. Before each action or screenshot, check:

- target identity and generation;
- URL and document epoch;
- visibility and page focus;
- worker ownership.

For a user-owned browser, prefer the visible target without activation.
Defer a background screenshot or pointer operation when active pixels are needed.
An explicit activation policy may activate once at the operation boundary.
Serialize activation with input and screenshot.
Keep the user's later target choice.

`Page.emulateFocusedPage()` changes page-observed focus without raising the OS window.
Restrict it to owned or headless policy.
It is a focus-control API, not user consent.

### Screenshot and cursor

Screenshot latency includes:

- compositor capture;
- image encoding;
- relay payload;
- host decode and resize;
- file write;
- artifact publication.

On native Chromium, compare viewport clip and full-page capture.
Also compare format and `optimizeForSpeed` when the consumer permits each option.
Keep Chromium/CDP capture controls on that surface.
Probe a backend before using them on Firefox/BiDi.

Cursor guidance:
- Keep a page cursor or highlight decorative.
- Install one small idempotent preload per target.
- Reinstall after navigation.
- Coalesce pointer updates with `requestAnimationFrame`.
- Start with `transform` and `opacity`.
- Set `pointer-events: none`.
- Honor `prefers-reduced-motion` ([Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-motion), [animation guidance](https://web.dev/articles/animations-guide)).
- Treat DOM overlays as layout and accessibility risks.
- Treat focus and hit testing as additional risks.
- CDP Overlay is Chromium-only.
- Prove screenshot visibility before relying on it ([CDP Overlay domain](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Overlay.pdl)).

Serialize these operations:

- navigation;
- clicks and drags;
- scrolls and key input;
- activation;
- target resolution and geometry reads;
- overlay changes;
- screenshot capture;
- session lifecycle;
- profile policy.

Keep unrelated commands out of a drag sequence.

Measure:

- target adoption and session setup;
- activation, visibility, and focus;
- document epoch;
- pointer-to-first-frame;
- screenshot response and image processing;
- screenshot bytes and frame misses;
- stale-target rejects and focus steals;
- relay reconnects.

Compare active visible and passive visible populations.
Compare hidden and owned-headless populations.
Visual latency and pixel correctness are benchmark-dependent.
User-state protection is a safety requirement.

## Conditional anti-bot controls

Start with a stable identity and the standard route.
Escalate after observed blocks, CAPTCHAs, or challenge failures.
Choose escalation controls only as needed:
- fingerprint randomization;
- stealth;
- proxies;
- challenge handling.
Browserless documents stealth overhead and recommends it when detection requires it ([stealth guidance](https://docs.browserless.com/browserql/best-practices#should-i-use-the-stealth-route-for-all-queries)).
It also warns that resource over-blocking can trigger detection ([resource guidance](https://docs.browserless.com/browserql/best-practices#reject-unnecessary-resources)).

For owned unauthenticated scraping, a coherent session and fingerprint pool may improve acceptance.
Record setup and proxy cost.
For owned authenticated scraping, keep account identity coherent.
Keep cookies and storage coherent.
Keep proxy geography and fingerprint coherent.
Rotation can force reauthentication or trigger account controls.

Headed/BiDi sessions and user relays keep their existing identity by default.
An owner policy is needed before stealth or fingerprint changes.
It is also needed before proxy or challenge changes.

Measure:

- challenge, block, and CAPTCHA rate;
- canonical extraction success;
- auth success;
- retries and rotations;
- setup overhead;
- proxy bytes and cost;
- p50, p95, and p99 latency.

Anti-bot success and speed depend on the target and route.
Human-like sleeps provide neither readiness nor performance evidence.

## Minimal adoption benchmark

Use an arm from the [minimum benchmark program](./browser-execution-performance.md#minimum-benchmark-program), or define a matched arm for the runtime change under test.

1. Define one workload class and fixture seed.
   Record browser, driver, and Puppeteer versions.
   Record cache/SW state and profile state.
   Record viewport and primary metric.
2. Define an independent safety predicate.
   Examples include an extraction checksum and semantic postcondition.
   Also use exactly-once interception, target freshness, and identity isolation.
   Keep user-owned mutation at zero.
3. Run baseline and treatment on matched fresh contexts or proven reset states.
   Randomize AB/BA order within blocks.
   Keep cold and warm populations separate.
   Keep headed BiDi and user-owned relay populations separate.
4. Record these spans:
   - launch;
   - queue;
   - lock;
   - policy;
   - audit;
   - protocol;
   - request;
   - cache/SW;
   - renderer;
   - readiness;
   - extraction;
   - serialization;
   - output;
   - retirement.
5. Report:
   - p50;
   - p95;
   - p99;
   - sample count;
   - paired difference or ratio;
   - correctness;
   - command count;
   - output bytes;
   - CPU/RSS;
   - event-loop lag;
   - queue wait;
   - target errors.
6. Promote an optimization when the claimed workload improves without a safety or identity regression.
   Label wide results inconclusive.
   Preserve the control arm and raw evidence.

Minimum metrics:

```text
end-to-end latency; phase spans; protocol commands and events; request pause time;
request and response bytes; cache and service-worker source; readiness condition;
page CPU, RSS, and heap; event-loop lag; active and queued work; result bytes;
canonical correctness; identity canaries; errors, retries, blocks, and retirements
```

## Rejected folklore

- `networkidle0` is not a universal readiness condition. Long-lived connections can keep it open.
- A sleep after every action pays delay without proving a postcondition.
- `Promise.all()` overlaps independent commands. It does not reduce command count.
- A permanent browser can accumulate memory, state, and failures. Owned workers need measured retirement.
- Cache disable and service-worker bypass have different semantics. Both can change application behavior.
- Broad resource blocking can break app boot and authentication.
- It can also break layout, extraction, and challenges.
- Stealth adds overhead. Targets without blocking may not need it.
- Per-request identity rotation can break authenticated continuity and trigger account controls.
- Keep visibility and window focus separate.
- Keep page focus and compositor freshness separate.
- A plan or one evaluation can reduce outer turns or equivalent commands. Renderer and serialization work remain.
- Navigation replaces the document and execution context. Re-resolve targets and discard stale handles.

## Version and source uncertainty

- This repository pins `puppeteer-core` 25.3.0. Public Puppeteer pages describe 25.11.0. Tagged-source review and runtime probing establish pinned behavior.
- Before changing a default, review the 25.3.0 source for:
  - `Page.evaluateOnNewDocument`;
  - interception and cache controls;
  - screenshots and locators;
  - BiDi support.
- These controls are Chromium/CDP mechanisms:
  - CDP Overlay;
  - screenshot encoding controls;
  - `Network.setCacheDisabled`;
  - `Network.setBypassServiceWorker`.
  Probe Firefox/BiDi separately.
- WebDriver BiDi behavior can change. Check the deployed driver for:
  - readiness;
  - preload;
  - navigation;
  - network events.
- Crawlee and Browserless document their crawler and provider implementations. Their evidence can guide owned workloads, but it does not define `browser-tools` behavior.
- A vendor throughput figure is valid only when the evidence identifies:
  - machine;
  - payload;
  - target;
  - rate;
  - correctness workload.
  This guide makes no product throughput claim.