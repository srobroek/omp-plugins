# Runtime Contract

## Development hook lifecycle

The local transport uses the GitHub CLI extension:

```text
gh extension install cli/gh-webhook
gh webhook forward --repo=OWNER/REPO --events=EVENTS --secret=SECRET --url=LOCAL_URL
```

Lifecycle verification on 2026-07-21 used `platevault/platevault`:

| State | Command | Result |
|---|---|---|
| Before start | `gh api repos/platevault/platevault/hooks` | No records |
| Forwarding | `gh webhook forward --repo=platevault/platevault --events=ping` | Active `cli` hook `655110579` at `https://webhook-forwarder.github.com/hook` |
| After Ctrl-C | `gh api repos/platevault/platevault/hooks` | No records |

The development hook exists only while the forwarder runs. Stop the process with SIGINT or SIGTERM so the extension removes it.

## Local state

The runtime stores a 32-byte random webhook secret with mode `0600`. It installs `cli/gh-webhook` under an isolated XDG data directory beside that secret. GitHub CLI authentication remains in the caller's configured credentials directory.

`cli/gh-webhook` v0.2.0 accepts the signing secret only through `--secret`. The secret is therefore visible in the forwarding child's argument list to the same user and privileged process inspection while the process runs. This local development transport is supported only on a trusted single-user machine and session; do not run it on a shared or multi-user host.

The default state directory is:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/release-queue-watch/OWNER--REPO
```

## Event and reconciliation boundary

`@octokit/webhooks` verifies `X-Hub-Signature-256` before queue mutation. Pull-request events update queue identity immediately. Check, status, and workflow events request a debounced Octokit REST reconciliation.

The runtime emits a `dispatch` record only when a PR is non-draft, has a clean GitHub merge state, and has passing observed checks. Existing `dispatch`, `watcher-active`, `reconcile-error`, and `webhook-error` record shapes remain unchanged.

Pull-request state changes emit one `pr-lifecycle` JSON record:

```json
{
  "type": "pr-lifecycle",
  "transition": "updated",
  "source": "webhook",
  "lifecycleKey": "owner/repo#42#abc123#updated#2026-07-21T01:00:00Z#f2d7349b675ea3c1",
  "pullRequest": {
    "repository": "owner/repo",
    "number": 42,
    "title": "Ready change",
    "headSha": "abc123",
    "baseRef": "main",
    "labels": ["priority:high"],
    "priority": 1,
    "draft": false,
    "mergeable": null,
    "checks": "pending",
    "createdAt": "2026-07-21T00:00:00Z",
    "updatedAt": "2026-07-21T01:00:00Z",
    "state": "blocked",
    "activeSince": null
  },
  "deliveryId": "github-delivery-id",
  "webhookAction": "synchronize"
}
```

| Transition | Signed webhook source | REST reconciliation fallback |
|---|---|---|
| `opened` | `opened` or `reopened` | Discovers an open PR absent from local state |
| `updated` | Any non-close PR action other than open/reopen | Detects changed head, metadata, mergeability, or checks |
| `failed` | Emitted after the check event triggers REST reconciliation | Checks change to `fail` |
| `merged` | `closed` with GitHub `merged=true` | Not inferred from absence |
| `closed` | `closed` with GitHub `merged=false` | A tracked PR disappears from the open-PR list |

Webhook records include `deliveryId` and `webhookAction`. Reconciliation records use `source=reconciliation`; failure and absence records also include a `reason`. A reconciliation-only close is not proof of merge, so consumers revalidate the PR through GitHub before mutating state.

`lifecycleKey` is deterministic across webhook and REST sources. Treat it as an opaque value: its final fingerprint covers the emitted PR state and the exact observed CI signals, so a new CI attempt gets a new key even when GitHub leaves the PR's `updated_at` timestamp unchanged. The runtime suppresses a repeated key within the process in addition to delivery-id rejection and semantic debounce. Consumers persist the key when they need restart-safe dedupe.

Initial REST reconciliation can emit lifecycle and dispatch records before `watcher-active`. Every record is read-only input: the runtime does not modify GitHub or Beads.

## Advisory wake dispatcher

`src/wake-dispatcher.js` exports `AdvisoryWakeDispatcher` for supervisors that
run the watcher and an integrator in the same process. Pass the dispatcher to
`startReleaseQueueRuntime` as `wakeDispatcher`; the runtime keeps its stdout and
stderr records unchanged. Shutdown stops new reconciliation, closes the webhook
receiver, awaits in-flight reconciliation, then drains pending wakes so no
producer can publish after the final drain.

The dispatcher accepts adapters for the orchestrate and pr-shepherd resolvers.
It sends a record to the shepherd resolver only when the orchestrate adapter
returns `status=unmatched`. Duplicate, informational, ambiguous, and invalid
orchestrate results never fall through. The selected wake callback receives the
exact repository, PR number, head SHA, event identity, target id, and resolver
`requiredMetadata`. That callback persists the receipt and wakes the target;
the watcher does neither operation itself.

Calls to `enqueue`, including records parsed through `enqueueLine`, run one at a
time in input order. Malformed NDJSON and resolver failures call `onFallback`
without invoking either consumer. A rejected wake leaves that record failed,
then releases the queue so a later durable replay can proceed.

Consumers process the NDJSON stream serially through durable Beads receipts.
An exact active orchestrate node has routing precedence. Only records unmatched
to orchestrate may be offered once to pr-shepherd; never fan one record to both
integrators. Either consumer revalidates GitHub before acting, and only the
selected integrator may acquire `bd merge-slot`.

Start through `pnpm --silent start` when stdout is machine-consumed. Lifecycle,
dispatch, and `watcher-active` records use stdout. `webhook-error` and
`reconcile-error` records use stderr; the process supervisor must parse both
streams and trigger the documented fallback on an error record or process exit.
