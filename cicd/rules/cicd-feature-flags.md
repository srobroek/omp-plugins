---
name: cicd-feature-flags
description: Decide when a change needs a feature flag, record its owner and cleanup date, test both states, and use truthful commit types for dormant, enabled, and removed code.
---

# Feature flag decisions

Decide per feature. Do not flag every change by default. A flag can safely merge incomplete work or control rollout and rollback. A complete small change needs none when it requires no staged exposure or rollback. [Fowler](https://martinfowler.com/articles/feature-toggles.html) explains toggle flexibility and its carrying cost. [DORA](https://dora.dev/capabilities/working-in-small-batches/) recommends small batches. [LaunchDarkly](https://launchdarkly.com/docs/guides/flags/technical-debt) warns that unnecessary flags create debt. [Feature flag guidance](https://docs.getunleash.io/concepts/feature-flags) classifies temporary release flags separately from longer-lived operational controls.

## Record the decision

Add exactly one `Flag:` line to the MR/PR description (and therefore to the squash commit body when the forge copies it):

<code>Flag: &lt;flag-name&gt; (default off; owner &lt;alias&gt;; remove by YYYY-MM-DD)</code>

<code>Flag: none &mdash; &lt;one-line reason&gt;</code>

Do not substitute other field names or omit the default, owner, or removal date for a temporary flag. A no-flag decision includes a concise reason.

## Lifecycle and testing

- Temporary flags default off. Name one owner for rollout and removal. State a concrete removal date. When the owner finishes rollout or abandons the feature, they open a cleanup MR/PR and remove the flag and dead path.
- CI tests both disabled and enabled states. Test flagged behavior in both states. Include relevant interactions when flags combine.
- To run unreleased flagged work locally, install the MR branch or pinned commit SHA. Enable the flag through an environment variable or local config, for example `FEATURE_FLAG_NAME=1`. Pre-merge previews also install the MR/PR branch or pinned SHA, or use a CI artifact built from that SHA. Do not use a moving `next`/`rc` branch: it can include unrelated changes and obscures the tested revision.
- Start with an environment variable, command-line option, or config value. Adopt OpenFeature or a hosted service only when multiple providers or centralized targeting justify the added machinery.
- Use truthful commit types. Dormant, not-yet-exposed plumbing is `refactor:` or `chore:`. A separate change that enables the capability for users is `feat:`. Flag removal and cleanup is `chore:` or `refactor:`. Do not mislabel a user-facing feature to avoid a release.

A published prerelease channel can be appropriate for real external testers who need an installable preview release. Treat it as an explicit opt-in testing exception, not the default feature-flag mechanism or a long-lived parallel development branch. For local and pre-merge work, branch/SHA installs test the exact change without publishing a channel.