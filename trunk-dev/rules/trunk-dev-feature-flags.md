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

<code>Flag: &lt;flag-name&gt; (default off; owner &lt;alias&gt;; remove by YYYY-MM-DD)</code>

<code>Flag: none &mdash; &lt;one-line reason&gt;</code> (non-feature changes only, such as a breaking `fix!` or `refactor!`)

A `feat` MR/PR names a real flag; `Flag: none` is not valid for it. Do not retype a feature as `fix` or `chore` to avoid the flag. Do not substitute other field names or omit the default, owner, or removal date for a temporary flag. A no-flag decision includes a concise reason.

## Lifecycle and testing

- Temporary flags default off. Name one owner for rollout and removal. State a concrete removal date. When the owner finishes rollout or abandons the feature, they open a cleanup MR/PR and remove the flag and dead path.
- CI tests both disabled and enabled states. Test flagged behavior in both states. Include relevant interactions when flags combine.
- To run unreleased flagged work locally, install the MR branch or pinned commit SHA. Enable the flag through an environment variable or local config, for example `FEATURE_FLAG_NAME=1`. Pre-merge previews also install the MR/PR branch or pinned SHA, or use a CI artifact built from that SHA. Do not use a moving `next`/`rc` branch: it can include unrelated changes and obscures the tested revision.
- Start with an environment variable, command-line option, or config value. Adopt OpenFeature or a hosted service only when multiple providers or centralized targeting justify the added machinery.
- Use truthful commit types. Dormant, not-yet-exposed plumbing is `refactor:` or `chore:`. A separate change that enables the capability for users is `feat:`. Flag removal and cleanup is `chore:` or `refactor:`. Do not mislabel a user-facing feature to avoid a release.

A published prerelease channel can be appropriate for real external testers who need an installable preview release. Treat it as an explicit opt-in testing exception, not the default feature-flag mechanism or a long-lived parallel development branch. For local and pre-merge work, branch/SHA installs test the exact change without publishing a channel.