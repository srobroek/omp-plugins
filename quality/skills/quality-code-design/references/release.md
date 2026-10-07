# Compatibility and release behavior

Read for persistent-state, API/event compatibility, network effects, or release work. Applying this guide does not authorize deployment or other external effects beyond the user's task.

## Mixed versions are consumers

**Do:** identify active callers, older deployed binaries, workers, queued events, installed clients, persisted formats, and supported rollback versions before changing a contract. Use evidence about deployment and retention, not just a search of source callers.
**Do not:** assume a monorepo deploys atomically or that merging updated callers eliminates old consumers.

Bad: rename a database column and remove its old name in the same release because every source reference was updated.
Good: add the new representation, deploy compatible readers/writers, migrate and verify data, then remove the old form once active consumers and the supported recovery path permit it.

Bad: write a new event format while some consumers can read only the old one.
Good: deploy readers that accept both formats before enabling new writers; verify rollout completion and queue/retention obligations before removing old-format support.

**Exception:** an internal contract with no external, persisted, mixed-version, or rollback obligation can change atomically with its callers. Avoid speculative compatibility layers.

## Recovery includes data

**Do:** define the supported recovery action and verify it against data written by the new version. Test upgrade, coexistence, and downgrade paths when their failure would be material. Bound temporary compatibility with an owner and removal condition.
**Do not:** call `git revert` a complete rollback plan for destructive data changes, or assume every migration has a safe inverse.

Bad: a rollback restores the old binary after the new binary deleted data it requires.
Good: postpone destructive cleanup until the compatibility window closes. When rollback is impossible, state that limit and verify the chosen forward-recovery or restore procedure against the project's recovery requirements before release.

**Exception:** a reviewed, authorized maintenance window can permit a coordinated cutover. Document the real downtime/recovery constraint; do not silently replace rolling compatibility with an outage.

## Retries and partial effects

**Do:** distinguish validation failures from transient failures; bound retries, timeouts, and concurrency. Account for duplicate delivery, cancellation, and partial completion. Use the operation's idempotency/reconciliation contract where effects matter.
**Do not:** infer from a timeout that an operation did not execute, or blindly retry a non-idempotent write with a fresh operation ID.

Bad: retry a timed-out charge with a new request ID and create a duplicate charge.
Good: reuse the stable idempotency key for the same intended operation, check the provider's contract, and reconcile uncertain outcomes. A different intended operation needs its own identity.

**Exception:** pure local computation needs no network retry framework. When an external API has no deduplication contract, do not promise exactly-once effects; use a supported reconciliation path or surface the unresolved risk.

## Observe the changed behavior

**Do:** select a relevant success signal, observation window, stop condition, and recovery action for release work. Use staged exposure or a canary when the system's risk and infrastructure justify it. Keep required release controls.
**Do not:** infer success from process startup, low CPU, or a merged PR; require a full SRE platform for a local utility.

Bad: declare a checkout change healthy because its container started.
Good: check the affected checkout operation and its failures/latency after authorized deployment, using existing instrumentation. Report gaps when runtime evidence is unavailable.

Bad: add an indefinite release flag with untested combinations.
Good: use a flag for a concrete exposure/recovery need, test supported states, and give it an owner and removal condition.

**Exception:** a small local tool can use clear errors and a representative smoke check. Formal SLOs and error budgets fit ongoing services with agreed reliability needs; do not impose uptime targets or permanent telemetry on one-off tools.

## Evidence and handoff

**Do:** distinguish implemented, locally verified, CI verified, merged, deployed, and observed. Include the relevant revision/artifact/environment and unresolved risk in the existing handoff format.
**Do not:** claim deployment from a merge or production health from preproduction tests. Respect read-only roles; reviewers request evidence through their allowed surface and never perform a release.

Bad: "Done in production" when only CI passed.
Good: "PR updated at revision X; focused checks and CI passed. No deployment was requested or performed."

**Exception:** omit inapplicable stages instead of generating a ceremonial release checklist for every change.

## Sources

- [AWS schema compatibility](https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/dl.ads.5-ensure-backwards-compatibility-for-data-store-and-schema-changes.html): coexistence and upgrade/downgrade verification.
- [AWS idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/): retries can repeat effects without an appropriate contract.
- [Google SRE canarying](https://sre.google/workbook/canarying-releases/) and [SLOs](https://sre.google/workbook/implementing-slos/): release evaluation and reliability priorities. Apply them proportionally, not as compulsory infrastructure.
