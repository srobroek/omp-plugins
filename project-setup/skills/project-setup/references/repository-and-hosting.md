# Repository and hosting

This topic follows the explicit topology classification. The deployment host is a separate
repository-level input settled before stack selection. Forge, visibility, branch, and
governance do not identify a deployment host.

## Asked

| Question | Notes |
|---|---|
| Project name, and one line describing it | In a monorepo member, the member name is the package's name. |
| Owning person or organisation | CODEOWNERS, package metadata, and release targets read it. An empty value remains a gap. |
| Supported forge platform | `github` or `gitlab`. `gitea`, `azure-devops`, and any other forge are explicit unsupported gaps unless a later asset set supplies their files. |
| Forge hostname | Ask only for a self-hosted GitHub or GitLab instance. Use the public hostname for a public forge. |
| Licence and copyright holder | Never derive either value. Recommend an SPDX identifier with its tradeoff, then let the user choose. Use `assets/governance/LICENSE.source` as the selection source. |
| Create the remote now | Publishing is an explicit action, not an inference. |
| Private or public, when the remote is created | Read the choice back before running a publishing command. |
| Security contact | An empty value uses the supported forge's private reporting mechanism; it does not invent an email address. |
| Code-of-conduct contact | Empty means no `CODE_OF_CONDUCT.md`; a reporting channel is required when that file is selected. |

Run each repository inspection once. Empty `git remote -v` output confirms that no remote exists.
Record `no remote` and continue; never retry the same inspection without new repository state.


Licence starting points:

| Identifier | Tradeoff |
|---|---|
| `MPL-2.0` | File-level copyleft, which suits a library that permits larger proprietary works. |
| `AGPL-3.0-only` | Network-use copyleft, which deters some SaaS forks and some adopters. |
| `Apache-2.0` | Permissive terms with a patent grant. |
| `MIT` | Permissive and minimal. |

Normalise an obvious spelling, say the correction, and do not re-ask it: `apache2` becomes
`Apache-2.0`. A licence not carried by the forge API falls back to the SPDX licence list and
remains a manual selection.

## Deployment host

Ask one repository-level host before any runtime or stack question. Use the host vocabulary in
`application.md`: `SELF_HOSTED_VM`, `OCI`, `KUBERNETES`, `AWS`, `AZURE`, `LOCAL`, `BROWSER`,
`DESKTOP`, `OTHER`, or `MULTI_HOST`. `MULTI_HOST` maps every accepted monorepo member or
deployable to a host. `OTHER` is an explicit capability-inspection path, not a fallback that
pretends an unsupported platform is configured.

## Derived

| Decision | Rule |
|---|---|
| Default branch | `main` |
| CI host | GitHub for GitHub repositories, GitLab for GitLab repositories. Other forges remain unsupported gaps. |
| Per-job timeout | 15 minutes. |
| Decisions directory | `docs/adr` |
| Coverage floor | 80 percent |
| Version matrix | Current stable only |

## Fixed assets and API state

The static library supplies `CODEOWNERS`, `SECURITY.md`, `CONTRIBUTING.md`, optional
`CODE_OF_CONDUCT.md`, issue and pull-request templates, Renovate configuration, release-please
configuration, a GitHub release workflow, and a GitLab root pipeline. The asset index names
which forge and conditions each file supports.

The repository API, not committed files, controls branch protection, required checks, merge
queues, allowed merge methods, auto-merge, issue/wiki/project switches, remote creation,
visibility, and credentials. A plan records those as API or manual state rather than claiming
a file controls them.

Release-please automation is supplied for GitHub by the checked-in workflow. A GitLab repository
may use the checked-in configuration as manual or separately operated release input; no GitLab
release runner is claimed here. Renovate configuration is a committed input, but enabling a
Renovate app or token remains API or manual state.

Do not claim Gitea, Azure DevOps, or another forge's CI, templates, branch protection, or release
integration. Record that platform as an unsupported gap until its assets and bounded behavior
exist.

## Publishing

Read the name, owner, and visibility back to the user and wait before running a command that
creates a public repository. Publishing happens at once. Never place a credential in a script or
committed file; record only the variable name and failure mode in `docs/agents/env/index.md`.
