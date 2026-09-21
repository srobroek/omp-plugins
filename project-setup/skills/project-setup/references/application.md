# Application shape

Topology, deployment host, and stack are separate decisions. Ask topology first, settle the
repository-level deployment host second, then select each stack. Never derive topology from
file counts, directory names, workspace manifests, or the number of languages present.

## Topology (asked)

Ask exactly one of these values:

| Answer | Meaning |
|---|---|
| `SINGLE` | This checkout owns one deployable or one package at the repository root. |
| `MONOREPO` | This checkout intentionally owns multiple deployables or packages with shared repository governance. |
| `POLYREPO` | Related repositories remain separate release and ownership units. This checkout is one of them. |

Show directory counts as evidence. The user chooses the topology.

For `MONOREPO`, ask the member paths and capability roots explicitly. A member row names the
path, deployable or package, and the capabilities it owns, such as runtime, tests, build, and
deployment. Recommend observed paths only as recommendations; do not infer or create members.
A capability root may be a path such as `apps/api`, `packages/sdk`, or `infra`; every path in
the plan must come from the accepted member map.

For `POLYREPO`, run setup independently for each checkout. Ask permission before carrying a
choice from a related repository into this one, including owner, forge, host, stack, release,
and governance. Permission to reuse a choice does not merge repositories or suppress this
checkout's questions. Without permission, treat related repositories as context only.

For `SINGLE`, ask the root deployable's shape and do not invent member paths.

## Web application architecture (asked before language)

For every web application whose backend has not already been excluded, ask exactly one shape before
asking about languages:

| Answer | Runtime surfaces and deployment ownership |
|---|---|
| `BROWSER_ONLY` | Browser UI only. No server or backend is created. |
| `INTEGRATED_FULL_STACK` | One deployable owns both a browser UI surface and a server surface. |
| `SPLIT_FRONTEND_BACKEND` | The browser frontend and backend are separate deployables. |

`SPLIT_FRONTEND_BACKEND` is incompatible with `SINGLE`. Reopen topology and the member map before
continuing; do not hide two deployment units behind one application label. An integrated full-stack
deployable may still use different languages on its browser and server surfaces.

## Language ownership (record known answers; ask unresolved answers after host)

Language belongs to a runtime surface, not to the repository. Build an explicit
`deployable -> runtime surface -> one or more languages` map. Common surfaces include browser UI,
server/API, worker, CLI, desktop host, and shared library. The same language may own several surfaces,
and one repository may contain any supported combination of TypeScript, Python, Go, Rust, or a
user-named language.

MUST Ask one question per runtime surface and put all currently unblocked surface questions in the
same round. Each language question uses multi-selection: selecting a language for one surface does
not answer another surface. Offer a same-language full-stack mapping as the recommendation when it
fits; never turn it into the only selection model.
MUST Load and apply every selected language reference independently after the deployment host is
settled. Shared repository tooling composes the selected language layers.
NOT Ask for one repository-wide or application-wide `primary language` when more than one runtime
surface exists.
NOT Infer that selecting TypeScript for a browser UI also selects TypeScript for its backend.

## Deployment host (asked before stack)

Ask one repository-level deployment host, separate from the source forge:

| Answer | Meaning |
|---|---|
| `SELF_HOSTED_VM` | A user-managed virtual machine runs the deployable. |
| `OCI` | An OCI-compatible image is the deployment artifact and a runtime runs it. |
| `KUBERNETES` | Kubernetes is the deployment control plane. |
| `AWS` | An AWS-managed deployment target is the primary host. |
| `AZURE` | An Azure-managed deployment target is the primary host. |
| `LOCAL` | A developer or operator machine runs the deployable. |
| `BROWSER` | A browser loads the deployable as the runtime. |
| `DESKTOP` | A desktop application runtime hosts the deployable. |
| `OTHER` | The host is not covered above; inspect its deployment capability before selecting assets. |
| `MULTI_HOST` | Map every accepted deployable or monorepo member path to one of the host values above. |

`MULTI_HOST` requires a complete member-to-host map. `OTHER` requires the provider or runtime,
deployment artifact, entrypoint, and operating owner to be recorded. Do not claim a host asset
until that capability inspection identifies what the asset can actually configure.

The host answer is a repository input even when every member uses the same host. It is settled
before runtime, framework, and language-stack questions.

## Deployable shape

Ask, per accepted deployable or member, only what its own answers leave open:

1. What it does, in one line. The name does not say.
2. Network exposure, as one exclusive choice: `NONE`, `INTERNAL_ONLY`, `PRODUCT`, or `BOTH`.
   `PRODUCT` and `BOTH` open the protocol frontier.
3. Whether it has background work. Yes opens the trigger-type frontier; no trigger type is asked here.
4. Whether it holds state that outlives one request. Yes opens persistence.
5. Whether a caller has an identity. Yes opens authentication.
6. Human-facing surfaces, as a multi-select: `WEB`, `WEBVIEW`, `NATIVE_DESKTOP`, `CLI_TUI`,
   `HUMAN_FACING_BACKEND_TEXT`, or `NONE`. Any non-`NONE` answer opens internationalization and
   accessibility.
7. Which runtime and framework it needs after the host is settled.

## Architecture decision records

Every accepted choice that constrains implementation enters the ADR manifest. Record at least:

- topology, member boundaries, and runtime surfaces
- language, runtime, and framework ownership per surface
- deployment host and infrastructure boundary
- external contracts and generated clients
- persistence ownership and authentication model
- background triggers, delivery guarantees, retries, ordering, and terminal failure handling
- localization architecture and accessibility controls
- CI, release, dependency, and agent-tooling boundaries

Group choices only when they share one rationale and would be superseded together. Keep independent
reversal boundaries in separate ADRs. Each manifest row contains a title, decision, rationale,
alternatives considered, consequences, and confirmation evidence. An accepted default is still a
decision and still gets a record.

For brownfield work, preserve existing ADRs. Add records for undocumented current choices and cite
the committed evidence that established each choice. Never rewrite history by presenting an
existing choice as newly adopted.

## Frameworks and libraries

Read a framework or library out of what the user already said. “A FastAPI service” names FastAPI,
and re-asking invites a contradictory answer. Otherwise ask the framework separately for each
runtime surface after its language is accepted. Present the best fit as
`RECOMMENDED — UNACCEPTED` with every credible, materially distinct alternative; never promote it
to an answer because it is the default or strongest fit.

Frontend framework, server framework, runtime-boundary validation, server-state client, HTTP
contract, and other independent library roles are separate settings. Ask each applicable role unless
a loaded stack reference marks it `FIXED` or an accepted answer derives it. Fixed TypeScript quality
tools do not fix React, Vite, Hono, Zod, TanStack Query, OpenAPI, or any application library.

## What this topic does not decide

- Infrastructure implementation. Ask whether the repository uses OpenTofu or a provider CDK;
  neither choice is derived from the host.
- Hosting forge, visibility, default branch, and governance, which are repository inputs.
- Marketplaces and registries, which stay with the user.
