# Protocols and events

Opens when a deployable serves callers over a network, publishes or consumes messages, or
runs work on a schedule. A deployable that does none of those skips this topic.

## The contract topic

Asset set: `skill://project-setup/assets/api/`

Opens when a deployable serves callers over HTTP and the interface is part of the product
rather than an internal detail.

| Question | Default | Notes |
|---|---|---|
| API title | the project name | `@@API_TITLE@@` in `openapi.yaml.template` |
| Contract version | `1.0.0` | `@@API_VERSION@@`. Separate from the release version: oasdiff compares two specs and never reads it, so it is documentation for a reader |
| Production server URL | `https://api.example.com` | `@@API_SERVER_URL@@` |
| Fail severity | `warn` | `@@API_FAIL_SEVERITY@@`. A missing description or an absent `operationId` is reported at warn, and both are exactly the drift a contract gate exists to catch |
| Baseline ref | `origin/<default branch>` | `@@API_BASELINE_REF@@`, the fallback for a local run and a push. A pull request is measured against the branch it targets: both CI systems export that as `API_BASELINE`, and the recipe prefers it |

Derived, not asked: `@@ORG@@` and `@@SPDX_ID@@` come from the repository and hosting
topic, `@@REPO_URL@@` from the remote, `@@DEFAULT_BRANCH@@` from the same topic, and
`@@JOB_TIMEOUT_MINUTES@@` from the per-job timeout.

Fixed, with no question and no token: vacuum for linting, oasdiff for breaking-change
detection, pinned in `.mise/conf.d/api.toml` to `vacuum = "0.30.3"` and
`"ubi:oasdiff/oasdiff" = "1.26.1"`. Both versions decide whether the gate passes, so neither is
`latest`; Renovate owns the bump. oasdiff installs through `ubi` because the aqua registry
carries no entry for it.

`--fail-on ERR` on the oasdiff call is mandatory rather than decorative. Verified against
oasdiff 1.26.1: removing an operation exits 0 without the flag and 1 with it, so the check
would otherwise pass while printing the breakage.

The shipped `openapi.yaml` describes a worked `/health` endpoint rather than `paths: {}`,
because an empty object lints clean while giving the first real endpoint no shape to
follow. Every schema and media type carries an example, since vacuum reports a missing one
at warn and the gate fails at warn.

This set contributes a lint workflow and no test workflow. The CI caller finds each kind
on its own, so that asymmetry needs no special handling.

## Clients generated from the contract

DEFAULT The contract is the source of truth and the client is generated from it. A
hand-written client beside a committed spec drifts silently, and nothing in the gate
catches it.

ASK where the generated client is committed, and which generator writes it, when a
consumer lives in this repository.

## Events, queues, and scheduled work

No asset set. This topic settles the shape so the deployable's own code can be written
against it, and records the answers in `docs/agents/conventions.md`.

Ask per deployable:

1. What triggers the work: a message on a queue, a published event, a clock, or a webhook.
2. Whether a duplicate delivery is possible. Every at-least-once transport makes it
   possible, so the answer names the idempotency key rather than denying the case.
3. What happens to a message that keeps failing: a dead-letter destination, and who reads
   it.
4. Whether ordering matters, and across what partition.
5. Whether the work must survive a process restart mid-flight.

LOAD rule://backend-background-jobs for the conventions the code then follows. Nothing
here restates them.

NOT A queue or broker chosen for the user. Naming one is an infrastructure decision with a
cost the user pays, and the deployable's own answers rarely force a single option.
