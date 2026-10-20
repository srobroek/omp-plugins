---
name: trunk-dev-feature-flags
description: Gate every new feature behind a default-off feature flag, record its owner and cleanup date, test both states, and use truthful commit types for dormant, enabled, and removed code.
---

# Feature flag decisions

Gate every new feature behind a default-off flag. This includes breaking `feat!` changes.

- The flag lets unfinished work merge to the default branch without exposing it, so the branch stays releasable.
- Turning the flag off rolls the feature back without a revert.
- Fixes, refactors, chores, docs, and other non-feature changes need no flag.

Keep flags cheap and short-lived. [Fowler](https://martinfowler.com/articles/feature-toggles.html) explains the carrying cost of toggles. [LaunchDarkly](https://launchdarkly.com/docs/guides/flags/technical-debt) warns that stale flags become debt. [DORA](https://dora.dev/capabilities/working-in-small-batches/) recommends small batches. [Feature flag guidance](https://docs.getunleash.io/concepts/feature-flags) separates temporary release flags from long-lived operational controls.

## Record the decision

Add exactly one `Flag:` line to the MR/PR description (and therefore to the squash commit body when the forge copies it):

<code>Flag: &lt;flag-name&gt; (default off; owner &lt;alias&gt;; remove by YYYY-MM-DD)</code> for the PR that adds a feature behind a new flag

<code>Flag: &lt;flag-name&gt; (enable; owner &lt;alias&gt;; remove by YYYY-MM-DD)</code> for the rollout PR that turns an existing flag on for users

<code>Flag: none &mdash; &lt;one-line reason&gt;</code> (non-feature changes only, such as a breaking `fix!` or `refactor!`)

A `feat` MR/PR names a real flag; `Flag: none` is not valid for it. A rollout PR keeps the flag's original owner and removal date. Do not retype a feature as `fix` or `chore` to avoid the flag. Do not substitute other field names or omit the owner or removal date for a temporary flag. A no-flag decision includes a concise reason.

## Choose the mechanism

Use the simplest mechanism that can switch the feature where it runs. Follow the repository's existing flag mechanism when it has one.

| Where the code runs | Mechanism | How it is switched |
| --- | --- | --- |
| CLI, library, OMP plugin, developer tool | Environment variable or command-line option, such as `TALLY_PRIORITY=1` | The user sets it; no release needed |
| Application with a config file | A key in its config, such as `features.priority: false` | Config change, no rebuild |
| Service on AWS | An [AWS AppConfig feature flag profile](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-creating-configuration-and-profile-feature-flags.html), read through the AppConfig Agent or Lambda extension | An AppConfig [deployment](https://docs.aws.amazon.com/appconfig/latest/userguide/deploying-feature-flags.html) with a deployment strategy, which supports gradual rollout and rollback |
| Several teams, percentage targeting, or experiments | A hosted flag service behind the [OpenFeature](https://openfeature.dev/docs/reference/concepts/evaluation-api) SDK, so code stays vendor-neutral | The flag service's console or API |

- Read every flag through one accessor module, for example `isEnabled("tally-priority")`. Do not scatter raw environment or config reads through the code.
- Make "off" the default in code, so a missing or unreadable flag disables the feature.
- Use the same name in code, config, and the `Flag:` line.
- State in the MR/PR description how to turn the flag on, for example `TALLY_PRIORITY=1`.
- A compile-time constant or bundler define is not a feature flag: switching it needs a rebuild. Use it only to keep dormant code out of a build, not for rollout or as a kill switch.
- After launch, a remote flag (AppConfig or a hosted service) can stay as a long-lived kill switch. Record it as an operational control in the cleanup chore, and remove temporary release flags on their date.

## Lifecycle and testing

- Temporary flags default off. Name one owner for rollout and removal. State a concrete removal date. When the owner finishes rollout or abandons the feature, they open a cleanup MR/PR and remove the flag and dead path.
- When a flagged `feat` PR/MR merges, trunk-dev creates a cleanup chore bead due on the recorded removal date. That covers `delivery_land`, `gh pr merge`, and `glab mr merge`. Do not create it in advance. If you must create one by hand, set `--due <removal date>` and `--metadata '{"trunk_dev_flag":"<name>"}'` so trunk-dev recognizes it. The named owner closes that chore with the flag-removal PR.
- CI tests both disabled and enabled states. Test flagged behavior in both states. Include relevant interactions when flags combine.
- To run unreleased flagged work locally, install the MR branch or pinned commit SHA. Enable the flag through an environment variable or local config, for example `FEATURE_FLAG_NAME=1`. Pre-merge previews also install the MR/PR branch or pinned SHA, or use a CI artifact built from that SHA. Do not use a moving `next`/`rc` branch: it can include unrelated changes and obscures the tested revision.
- Use truthful commit types. Dormant, not-yet-exposed plumbing is `refactor:` or `chore:`. A separate change that enables the capability for users is `feat:`. Flag removal and cleanup is `chore:` or `refactor:`. Do not mislabel a user-facing feature to avoid a release.

A published prerelease channel can be appropriate for real external testers who need an installable preview release. Treat it as an explicit opt-in testing exception, not the default feature-flag mechanism or a long-lived parallel development branch. For local and pre-merge work, branch/SHA installs test the exact change without publishing a channel.