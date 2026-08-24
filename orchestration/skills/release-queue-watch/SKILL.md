---
name: release-queue-watch
description: Run the signed local GitHub PR-queue webhook receiver. Use when asked to keep watching, monitor the PR queue, watch CI, or dispatch merge slots. Never for merge, rebase, close, or repair.
---

# Release Queue Watch

A signed local GitHub webhook receiver over `node:http`. Paths: `POST /webhooks/github`, `GET /healthz`. It forwards repository webhooks through `cli/gh-webhook`, reconciles missed events against the GitHub REST API every 60 seconds, tracks agent-owned merge-slot state in memory, and emits NDJSON `pr-lifecycle` and `dispatch` records on stdout.

It MUTATES NOTHING. Never merge, rebase, close, push, or touch beads. It never reads `.beads/` and never shells out to `bd`. The only subprocess is `gh`. Runtime state lives in `~/.local/state/release-queue-watch/<owner--repo>/`.

`github` `run_watch` cannot replace this. That op polls a single Actions run or commit until terminal and gives up after 90 seconds. It has no webhooks, no PR lifecycle, no merge slots, no NDJSON, and no wake routing.

TRIGGER
+ "keep watching", "monitor the PR queue", or "watch CI"
+ "dispatch the next PR" or "use available merge slots"
- Merge, rebase, close, or repair a PR → pr-shepherd or an implementation lane

## Workflow

1. Resolve the runtime at `skill://release-queue-watch/scripts/webhook/`.
2. Run `pnpm install --frozen-lockfile` in that directory before first start or after a lockfile change. Do not vendor `node_modules` into the plugin tree.
3. Supervise with `hub op:"start"`:
   - `application` is `node` (or `pnpm` with `start`)
   - args include `--repo=OWNER/REPO --slots=NUMBER`
   - `ready.port` after listen
   - `restart: on-failure`
   - project-scoped broker
   Keep stdout NDJSON. The runtime creates a private persisted secret, provisions `cli/gh-webhook` in isolated XDG data, and starts the signed local receiver before forwarding. Consume structured error lines from stderr too.
4. Consume JSON `pr-lifecycle` records as read-only state changes and `dispatch` records as agent-owned work slots. Serialize the handoff: resolve an exact orchestrate node first; only an unmatched result may route the unchanged record once to pr-shepherd. Never fan one record to both. Keep one advisory wake in flight. Ready PRs rank by priority label, enqueue time, repository, then PR number.
5. Leave REST reconciliation enabled. It repairs missed webhook state and emits fallback lifecycle records every 60 seconds by default. Debounce equivalent events for 30 seconds and reject repeated delivery IDs.
6. Stop with SIGINT or SIGTERM. Load `skill://release-queue-watch/references/runtime.md` for record schemas, fallback semantics, hook setup, or cleanup diagnosis.

## Rules

MUST Keep the runtime read-only: never merge, rebase, close, push, or modify Beads.
MUST Accept webhook state only after `@octokit/webhooks` verifies the signature.
MUST Treat lifecycle and dispatch records as input only; orchestrate or pr-shepherd owns Beads, gates, conflict probes, and merge mutations.
MUST Never fan one record to both orchestrate and pr-shepherd.
MUST Keep one advisory wake in flight; persist required receipt metadata inside the selected consumer before sending its wake.
MUST Run the development forwarder only on a trusted single-user host; `cli/gh-webhook` v0.2.0 exposes `--secret` in the child argument list.
DEFAULT Use one merge slot unless the user supplies another positive integer.
NOT Use Smee; `cli/gh-webhook` is the local development transport.
NOT Treat webhook delivery as complete state; Octokit REST reconciliation remains active.
NOT Substitute `github` `run_watch` for this daemon.

OUTPUT
L1 WATCHER ACTIVE -- signed events, REST reconciliation, and <N> merge slot(s)
CAP 100w clean · 180w with findings
