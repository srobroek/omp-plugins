---
name: find-tools
description: Discover and vet reusable skills, agents, MCP servers, and APM packages. Use when asked to find a capability or decide to adopt, reject, or build.
---

# Find Tools

OMP-first discovery workflow for reusable agentic capabilities. Prefer local
inventory and already-registered marketplaces before public search. Do not
install discovered tools globally by default.

## References

- `skill://find-tools/references/discovery-sources.md` for the seven query
  surfaces and the excluded aggregators.
- `skill://find-tools/references/adoption-policy.md` for Use existing / Adopt /
  Trial / Reject / Build.

## Workflow

1. Clarify the capability: domain/task, artifact type, target runtime, constraints (license, hosted/local, secrets, network, writes).
2. Call `find_tools_scan` with that query. Inspect per-surface hits and the gap list. Empty `discover` never means nothing exists — keep later surfaces and the empty-result caveat.
3. If inventory already covers the need, recommend the existing package and stop.
4. Verify serious candidates before recommending: source, maintainer, license, activity, actual SKILL/agent/MCP schema, required binaries/keys/network/writes, destructive tools, overlap with installed plugins.
5. Classify each candidate with the decision vocabulary below.

## Rules

- Install-mutating commands (`npx skills add`, `smithery mcp add`, curl-pipe-shell) are trial-only after explicit approval. They are never part of discovery.
- Registry pages are discovery sources, not sufficient verification.
- Do not treat an empty `omp plugin discover` as a closed search.

## Output

Lead with one decision: `Use existing`, `Adopt`, `Trial`, `Reject`, or `Build`.
Then list searched surfaces, shortlisted candidates, verification notes,
overlap, install path, and caveats.

Add a **decision-matrix row per candidate**:

| name | type | source URL | license | last activity | overlap with installed | install path | verdict |
