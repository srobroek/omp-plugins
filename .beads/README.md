# Beads - AI-Native Issue Tracking

Welcome to Beads! This repository uses **Beads** for issue tracking - a modern, AI-native tool designed to live directly in your codebase alongside your code.

## What is Beads?

Beads is issue tracking that lives in your repo, making it perfect for AI coding agents and developers who want their issues close to their code. No web UI required - everything works through the CLI and integrates seamlessly with git.

**Learn more:** [github.com/steveyegge/beads](https://github.com/steveyegge/beads)

## Quick Start

### Essential Commands

```bash
# Create new issues
bd create "Add user authentication"

# View all issues
bd list

# View issue details
bd show <issue-id>

# Update issue status
bd update <issue-id> --claim
bd update <issue-id> --status done

# Sync with Dolt remote
bd dolt push
```

## Agent planning and sync contract

Before an implementation wave starts, the lead MUST record a DAG review against
these guard rails: every task names bounded files or symbols and independently
verifiable acceptance criteria; design decisions are separate decision or
research beads; review beads depend on every task they review; dependencies
encode true ordering only; implementer `metadata.tier` values are justified;
and the plan has an explicit integration and delivery path. A failed guard rail
requires a revision bead or blocks the wave. The review records the plan,
nodes, edges, tier justifications, and any revision or blocking decision.

For `bd create --graph`, `parent_key` names a node in the same plan. To attach a
new node to an existing parent bead, use node-level `parent_id`; a dry run must
show the expected parent-child link count. Use top-level `edges` for dependencies
and inspect the node and edge counts before creating the plan.

Run `bd dolt pull` before a read that decides assignment and `bd dolt push` after
delivery. A failed pull or push is retried at most three times. If the last
attempt may have applied remotely but its result is unknown, report UNKNOWN and
do not claim synchronization; never fall back to a manual `dolt` command or
continue as if the remote were current. Pull again before trusting an assignment
read after a retry sequence.

### Working with Issues

Issues in Beads are:
- **Git-native**: Stored in Dolt database with version control and branching
- **AI-friendly**: CLI-first design works perfectly with AI coding agents
- **Branch-aware**: Issues can follow your branch workflow
- **Sync-ready**: Uses Dolt remotes for backup and team sharing

## Why Beads?

✨ **AI-Native Design**
- Built specifically for AI-assisted development workflows
- CLI-first interface works seamlessly with AI coding agents
- No context switching to web UIs

🚀 **Developer Focused**
- Issues live in your repo, right next to your code
- Works offline, syncs when you push
- Fast, lightweight, and stays out of your way

🔧 **Git Integration**
- Dolt-native sync via bd dolt push / bd dolt pull
- Branch-aware issue tracking
- Dolt-native three-way merge resolution

## Get Started with Beads

Try Beads in your own projects:

```bash
# Install Beads
curl -sSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

# Initialize in your repo
bd init

# Create your first issue
bd create "Try out Beads"
```

## Learn More

- **Documentation**: [github.com/steveyegge/beads/docs](https://github.com/steveyegge/beads/tree/main/docs)
- **Quick Start Guide**: Run `bd quickstart`
- **Examples**: [github.com/steveyegge/beads/examples](https://github.com/steveyegge/beads/tree/main/examples)

---

*Beads: Issue tracking that moves at the speed of thought* ⚡
