# Protocols and events

Open each section independently. Product network exposure opens protocol classification.
`HTTP_OPENAPI` opens the contract section. Background work opens trigger classification. Durable
state opens persistence. Caller identity opens authentication. Skip only sections whose prerequisite
is absent.

## Network protocol classification

For `PRODUCT` or `BOTH`, ask one multi-select question with these atomic options:

- `HTTP_OPENAPI`
- `HTTP_OTHER`
- `GRPC`
- `WEBSOCKET`
- `OTHER`

For `OTHER`, ask for each protocol name. Record every accepted non-OpenAPI product protocol by name
as an unsupported gap unless another asset set provides its contract and gate.

## The contract topic

Asset set: `skill://project-setup/assets/api/`

Opens when a deployable serves callers over HTTP and the interface is part of the product
rather than an internal detail.

| Question | Default | Notes |
|---|---|---|
| API title | the project name | `@@API_TITLE@@` in `openapi.yaml.template` |
| API purpose | derived from the accepted one-line deployable purpose | `@@API_DESCRIPTION@@` |
| Contract version | `1.0.0` | `@@API_VERSION@@`. Separate from the release version: oasdiff compares two specs and never reads it, so it is documentation for a reader |
| Production server URL | GAP until supplied or derived from an accepted deployment | `@@API_SERVER_URL@@`; never recommend or emit a placeholder endpoint |
| Fail severity | `warn` | `@@API_FAIL_SEVERITY@@`. A missing description or an absent `operationId` is reported at warn, and both are exactly the drift a contract gate exists to catch |
| Baseline ref | `origin/<default branch>` | `@@API_BASELINE_REF@@`, the fallback for a local run and a push. A pull request is measured against the branch it targets: both CI systems export that as `API_BASELINE`, and the recipe prefers it |

Derived, not asked: `@@ORG@@` and `@@SPDX_ID@@` come from the repository and hosting topic;
`@@DEFAULT_BRANCH@@` comes from the same topic; `@@JOB_TIMEOUT_MINUTES@@` comes from the per-job
timeout. Use `@@REPO_URL@@` only when an accepted remote exists; otherwise delete only the optional
contact URL.

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

No asset set. This topic settles the shape so the deployable's code can follow it. Record each
accepted background-work boundary in the ADR manifest.

Ask per deployable. Trigger types are additive: ask them in one multi-select question with atomic
options `QUEUE_MESSAGE`, `PUBLISHED_EVENT`, `SCHEDULE`, and `WEBHOOK`. Do not offer
`NO_BACKGROUND_WORK`; the accepted opener already established that background work exists. Do not
offer a compound option. Selecting multiple atomic options records the combination.

For every selected trigger type, ask:

1. Whether duplicate delivery is possible. Every at-least-once transport makes it possible, so the
   answer names the idempotency key rather than denying the case.
2. What happens to work that keeps failing: a dead-letter destination or equivalent terminal state,
   and who reads it.
3. Whether ordering matters, and across what partition.
4. Whether the work must survive a process restart mid-flight.

Ask schedule expressions only for `SCHEDULE`, webhook authentication and replay handling only for
`WEBHOOK`, and message/event schema ownership only for the corresponding selected trigger.

## Persistence technologies

Opens for each deployable that holds state beyond one request. First ask storage roles as one
multi-select question with atomic options: relational records, key/value or document records,
objects or blobs, cache, search index, time-series or analytics, and external system of record.
External systems may coexist with owned stores. Do not offer compound answers such as
`PostgreSQL + object storage` or a `Multiple specialized stores` option.

After roles are accepted, ask the implementation for each selected role. Default each implementation
question to multi-select unless its accepted architecture permits exactly one adapter. A product
selected for one role does not settle another role. Ask no database product question when the
deployable owns no durable state.

## Authentication methods

Opens for each deployable whose caller has an identity. Authentication methods are additive: ask
them as one multi-select question with atomic options such as OIDC federation, social OAuth,
email and password, passkey/WebAuthn, and magic link or email OTP. Add another method only when the
accepted caller and runtime can implement it. Do not offer `Multiple methods`; the selected set is
the combination.

For two or more selected methods, ask account-linking identity, verified-attribute precedence,
recovery paths, and step-up or MFA policy. Ask provider and protocol details only for the methods
that need them. A credential remains a later secret input and is never accepted in the interview.

Authentication implementation is a separate question from authentication methods. Use
single-selection for an implementation library only when exactly one library must own the runtime's
session and account model; state that exclusivity invariant. Selecting one method never selects the
implementation library or suppresses other methods.

LOAD rule://backend-background-jobs for the conventions the code then follows. Nothing
here restates them.

NOT A queue or broker chosen for the user. Naming one is an infrastructure decision with a
cost the user pays, and the deployable's own answers rarely force a single option.
