---
name: whats-new
description: Research breaking changes, deprecations, and new features between the version in use and latest. Triggers on "what's new in X", "what changed", "safe to upgrade".
---

# What's New (Upgrade & Change Research)

On-demand research skill. For a named target -- or, with no target, the things
the current repo depends on -- find what changed between what is **in use** and
the **latest**, and summarize it as: breaking changes, deprecations, new
features/capabilities, and notable fixes.

Fetch changes **programmatically**, not by reading rendered web pages. Versions,
tag lists, changelogs, and service announcement streams have machine endpoints
(JSON, RSS/Atom, git) that return small structured output.
`skill://whats-new/references/recipes.md` is the cookbook. Reserve web fetching
for genuine prose (a migration guide, a post explaining a breaking change).

## Target kinds

- **Versioned software** (library, CLI, framework, runtime, package, container
  image): has a registry + a git repo + semver. Research a *version span*
  current→latest. Recipes steps A--D.
- **Service / technology / platform / API / model family** (AWS Bedrock,
  Anthropic/Claude models, OpenAI, GCP, Azure, Stripe, GitHub Actions): no
  semver. Research a *dated announcement stream* since the user's reference
  point. Recipes step E.

A target can be both -- research both sides when relevant.

## Inputs

Honor whatever the user supplies; only discover the rest.

- **Target** -- if absent, discover it (step 1).
- **Reference point** -- for software, the current version; for a service, the
  user's baseline date or what they currently use. If absent for a service,
  default to the last 6 months and state it.
- **Latest** -- the registry's latest version, or "now" for a service stream.

## Workflow

1. **Resolve the target and its kind.** If named, use it. Otherwise run the
   `version_gap_scan` tool to list declared dependencies. If it returns
   more than one equally plausible candidate, list them and ask.
   Decide: versioned software or service/stream.

2. **Resolve sources programmatically.**
   - *Software* (recipes A/B): current version (prefer lockfile), registry
     latest, version list, upstream repo URL.
   - *Service/stream* (recipes E): vendor's machine-readable change source
     (RSS/Atom feed, release-notes JSON, models API, or changelog repo) and the
     time window.

3. **Gather changes programmatically.**
   - *Software* (recipes C): bare `git` clone -- CHANGELOG at the target tag +
     conventional-commit-classified log across the span. Enrich with host
     release notes via its API.
   - *Service* (recipes E): pull the feed/release-notes/model-list, filter to
     the window, group.

4. **Fill prose gaps only if needed** (recipes D): fetch a migration guide or
   deprecation timeline. Prefer vendor guides over third-party blogs.

5. **Summarize into the template.** LOAD `skill://whats-new/references/report-template.md` and
   fill every section. Cite a source (release tag, commit SHA, CHANGELOG
   heading, feed entry date, doc URL) for every change flagged breaking or
   touching a public API.

6. **Save or return** -- return inline; save to a file only if asked or if the
   report exceeds 500 words.

## Steering

- **Report, don't upgrade.** Never edit manifests, bump versions, or run installers.
- **Programmatic over manual.** Catch yourself reading a rendered registry page → stop and use the matching recipe.
- **Cover the whole span.** Every intermediate version (software) or the full window (service) -- not just the endpoints.
- **Classification is heuristic.** A `feat:`/`fix:`/`!` prefix is a signal, not ground truth; read the diff for load-bearing changes.
- **State coverage honestly.** Name the sources that ran and those that were missing.
- **Services have no semver.** Anchor on dates, not version numbers. Note announcements ≠ regional/account GA for service targets, always.

## Scripts

| Script | Purpose |
|--------|---------|
| `version_gap_scan` tool | No-network enumeration of declared dependencies + pinned versions across ecosystems. |

For everything network-facing use the commands in `skill://whats-new/references/recipes.md`.
