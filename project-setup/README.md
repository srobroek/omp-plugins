# project-setup

Set a repository up, or retrofit one, through an interview that ends in an approved plan.

The command is the only entry point. Nothing here triggers on a conversational "let's set
up a project": a setup run writes across the whole repository, so it starts when the user
asks for it by name.

The workflow classifies the checkout as GREENFIELD or BROWNFIELD, reads back every claim
the conversation already made instead of assuming it, settles the host before any stack,
and works one topic at a time. Each topic appears as a numbered round and must be accepted before
the next opens. The plan lists one row per destination path with its class and its resolved
values, and the user approves it before the first file is written.

No state is kept. There is no run file and no recorded answer set: the repository's own
committed files are the record, and a second run re-reads them.

## Commands

| Name | What it does |
|------|--------------|
| `/project-setup [notes]` | Enter the setup workflow. Trailing text is treated as prior instruction to confirm, not as settled answers |

## Skills

| Name | When |
|------|------|
| `project-setup` | Entered by the `/project-setup` command |

## Asset library

`skills/project-setup/assets/` holds the files the approved plan copies: repository and
governance baselines, an ADR template, bundled license texts, GitHub and GitLab templates,
Renovate and release-please inputs, Worktrunk configuration, the Just task surface, prek hook
fragments, language quality and CI fragments, API contracts, an AWS CDK v2 TypeScript generator,
and the `docs/agents/` steering tree.

A file ending in `.template` carries `@@UPPER_SNAKE@@` tokens, or blocks fenced by
`# OPTIONAL BEGIN` and `# OPTIONAL END` that are kept or deleted whole. Everything else is
copied byte for byte. No template engine runs: the agent resolves each file against the
plan it showed.

Every accepted architecture decision is committed under `docs/adr/`. With the beads plugin,
decision beads are authoritative and `skill://adr/templates/` renders the files. Without it,
project-setup copies its MADR template once per accepted decision.
