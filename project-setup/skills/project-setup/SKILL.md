---
name: project-setup
description: Sets a repository up through an interview, an agreed plan, and a copied asset library. Triggers on the /project-setup command.
---

# Project Setup

TRIGGER
+ the `/project-setup` command ran
- "set up a project", "scaffold this", "add CI" said in conversation → answer in the
  conversation and name the command; this workflow starts no other way
- one tool to add to a working repository → that tool's own skill

GATES
ASK each topic's questions as one round, and accept the topic before the next opens
ASK the plan, before the first file is written
ASK the licence, a published repository, a credential, a machine-global registration

## Workflow

1. Classify the checkout. An explicit GREENFIELD or BROWNFIELD instruction wins.
   Otherwise run `git rev-parse --is-inside-work-tree` and count tracked files: no
   repository or zero tracked files is GREENFIELD; anything else is BROWNFIELD. Show
   the evidence. BROWNFIELD reads committed configuration before asking anything.
2. Confirm prior instruction. Number every claim the command arguments and this
   conversation already make, read them back, and ask which hold. An unconfirmed claim
   is a gap. LOAD skill://project-setup/references/interview.md
3. Ask for `SINGLE|MONOREPO|POLYREPO`; never infer ownership topology from directories.
   Then classify deployables, application classes, and known languages without choosing
   runtimes or frameworks. LOAD skill://project-setup/references/application.md
4. Settle the deployment host before any stack. Ask one repository-level host by default.
   MULTI_HOST maps each deployable to a host. Forge, visibility, default branch, and
   governance remain separate repository inputs.
   LOAD skill://project-setup/references/repository-and-hosting.md
5. Work the remaining topics one at a time:
   - runtime, framework, and libraries
   - interfaces, protocols, data, persistence, events, and workflows
   - frontend and UI
   - testing, quality, and observability
   - infrastructure, environments, and secrets
   - git, CI, releases, and dependencies
   - agent instructions, harnesses, skills, and plugins
   Each topic is a frontier: ask every unblocked question together with one ranked
   recommendation and every credible, materially distinct alternative. Offer `Accept topic
   recommendations` and individual answers. Read answers back, then ask the user to accept or
   revise the topic. A revision reopens it and every later answer that depended on it.
   LOAD the matching stack reference per language: skill://project-setup/references/stack-typescript.md,
   skill://project-setup/references/stack-python.md, skill://project-setup/references/stack-rust.md,
   skill://project-setup/references/stack-go.md
   LOAD skill://project-setup/references/protocols-and-events.md when an interface, event,
   queue, stream, or scheduled job applies; LOAD skill://project-setup/references/delivery-and-tooling.md
   for repository delivery and tooling.
   LOAD skill://project-setup/references/plugins.md for the final project-scope plugin topic.
6. Write the exact plan. One row per destination path: the asset it comes from, the class
   CREATE|OVERWRITE|MERGE|SKIP, and each token's resolved value. List every command the
   apply step will run, and every file a generator will rewrite. A plan carrying an
   unresolved token or class is not ready to show.
   LOAD skill://project-setup/references/assets.md
7. Show the plan and wait. Apply it only after the user approves it, and write no path
   the plan does not list.
8. Verify, and report each command with its own output.
   LOAD skill://project-setup/references/verification.md

## Rules

MUST Ask only what no reference fixes or derives; each reference marks which of its
  settings are asked, derived, and fixed.
MUST Offer memory, a stored preference, and a tool lookup as the recommendation inside a
  question, and record neither as an answer.
MUST Refuse to write a secret-shaped value into a file, say that the value now sits in a
  transcript and has to be rotated, and leave that setting a gap.
MUST Name no marketplace, registry, or plugin source that the user did not name.
MUST Read name, owner, and visibility back before running a command that publishes.
NOT Setup state on disk. No run file, no recorded answer set: the repository's committed
  files are the record, and a second run re-reads them.
NOT "Setup complete" in place of output, which hides a failed build.
