# delivery

The delivery plugin enforces commit and primary-checkout boundaries for Git work in OMP.
It also documents pull-request review, landing proof, native isolation cleanup, and Beads linkage.

## Agents

| Name | When |
| --- | --- |
| `pr-reviewer` | Review a pull request without changing it. The agent returns `VERDICT:` only and has no shell access. |

## Rules

| Name | When |
| --- | --- |
| `delivery-git-workflow` | Create or review pull requests, run automated-review loops, prove landing, clean native isolation clones, or link delivery to Beads. |

## Extensions

### `main-branch-gate`

The gate blocks commits that target a repository with `main` or `master` checked out.
It resolves the repository from the bash call `cwd` or an explicit `git -C <path>` target.

The extension receives raw shell text and admits only direct, statically readable Git shapes.
It refuses wrappers, aliases, unknown `git-*` helpers, dynamic targets, shell cwd transitions, and brace or subshell grouping when Git appears in the command.
Agents MUST NOT checkout or switch to `main` or `master`, or locally merge on those branches, unless repository-local steering explicitly authorizes the operation.
An explicit user request or the absence of a PR flow does not authorize it.

Git must report the target repository and branch before the commit gate can decide.
A failed or detached branch lookup allows the call.

A protected commit is allowed only when the same bash tool call's structured `env` contains `DELIVERY_ALLOW_MAIN_COMMIT=1` and the target repository contains this exact line:

`MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.`

The line must appear by itself outside Markdown fenced code blocks in a non-symlink root `AGENTS.md` or `CLAUDE.md`, or in a direct non-symlink `.omp/rules/*.md` file on the trusted remote default branch.

Before the first authorization in a session, the extension records the normalized `remote.origin.url`, resolved Git common directory, default ref, and remote HEAD SHA for that repository.

Every later authorization re-reads the configured origin, requires the same identity, and queries that pinned identity explicitly for the same default ref and SHA.

The gate reads that committed tree at the exact pinned remote SHA; an unavailable, malformed, ambiguous, redirected, or unreadable response denies authorization. It never falls back to mutable local `origin/HEAD`, `origin/main`, or `origin/master` refs.

The parsed tree cache is keyed by repository and exact remote SHA. An origin identity or remote HEAD change invalidates the positive decision and cannot reuse the old authorization.

A line with incidental surrounding text does not authorize the operation.
Any exact `MUST NOT authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.` line outside a fenced block vetoes the authorization.

### `primary-checkout-gate`

The gate blocks `edit`, `write`, and commits whose target lies in a repository's primary checkout.
The primary checkout is the checkout whose Git directory equals its common Git directory.
Redispatch repository work with `isolated: true` so OMP places it in standalone clones under its configured isolation root. Those clones pass even when Git classifies them as primary.
Paths outside a repository, internal URIs, and the `.omp/` and `.beads/` state directories pass.

A protected primary checkout is allowed only when the same bash tool call's structured `env` contains `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` and the trusted remote default tree contains this exact line:

`MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.`

The same committed-source, fenced-block, symlink, and veto rules apply to this authorization.
A bash call carrying the authorized structured `env` override grants later `edit` and `write` calls in that same canonical primary checkout for the current session.
`git remote -v` and `git fetch` remain classified as read operations even when the origin anchor is absent or mismatched; their remote-derived output remains advisory and untrusted until the configured origin, default ref, and remote HEAD SHA are verified against an unchanged anchor. `git remote set-url`, `git remote add`, `git remote remove`, `git remote rename`, `git config remote.origin.*`, aliases, and wrappers that can perform those mutations are denied in the primary checkout.
The grant does not transfer to another repository or an OMP-isolated clone.

Read-only primary-checkout commands (`status`, `diff`, `log`, `show`, and `fetch`) remain allowed and advisory when the origin anchor is absent or mismatched: remote-derived output is untrusted until the configured origin, default ref, and remote HEAD SHA are verified against an unchanged anchor. Push remains pinned and fail-closed.

Primary-checkout commits use the canonical-main exception: they require the same
`DELIVERY_ALLOW_MAIN_COMMIT=1` command-local environment factor and the main-commit
directive above. `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` never authorizes a commit;
that factor remains separate for edit/write authorization and session grants.

The gate is advisory-strength.
Filesystem tampering before the extension observes a repository, or before session startup, is outside this boundary. After first observation, every origin-anchor or remote-authority mismatch fails closed for protected actions, invalidates cached trust, and blocks push and protected overrides; classified reads remain allowed and advisory.
It does not parse shell commands that write files through redirection, scripts, or utilities such as `sed -i`.

### `unpushed-work-advisory`

At session stop, this extension reports dirty paths it observed and unpushed commits since its repository baseline.
Path counts do not establish authorship or permission to stage or publish a file.
