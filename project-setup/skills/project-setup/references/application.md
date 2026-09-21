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
2. Whether it serves callers over a network. Yes opens the protocols and events topic.
3. Whether it holds state that outlives one request. Yes opens persistence.
4. Whether a caller has an identity. Yes opens authentication.
5. Which runtime and framework it needs after the host is settled.

## Frameworks

Read the framework out of what the user already said. “A FastAPI service” names it, and
re-asking invites a contradictory answer. Ask the framework only when two frameworks fit the
accepted shape equally, with the tradeoff for each option.

## What this topic does not decide

- Infrastructure implementation. Ask whether the repository uses OpenTofu or a provider CDK;
  neither choice is derived from the host.
- Hosting forge, visibility, default branch, and governance, which are repository inputs.
- Marketplaces and registries, which stay with the user.
