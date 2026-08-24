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

1. Clarify the capability:
   - domain and task
   - artifact type: skill, agent, MCP server, connector, CLI, or build our own
   - target runtime: OMP (native plugin / skill / MCP), project-local, or
     user-global
   - constraints: license, hosted/local, secrets, network, write access
2. Query surfaces **in this order**. Stop early if inventory already covers the
   need. Empty results at surface 2 never mean "nothing exists".
   1. Local inventory — `omp plugin list`, `omp plugin marketplace list`,
      `~/.omp/agent/mcp.json`
   2. `omp plugin discover [marketplace]` — **only catalogs already added**
      with `omp plugin marketplace add`. There is no global crawl. An empty
      result means "nothing in registered catalogs", not "nothing exists".
      Always continue to surfaces 3–6 (and 7 if keyed) before concluding
      absence.
   3. Official MCP Registry —
      `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<q>&version=latest`
      (anonymous read)
   4. vercel skills CLI — `npx skills find <query>` (`--owner <org>`)
   5. npm registry —
      `GET https://registry.npmjs.org/-/v1/search?text=keywords:<kw>`
      Keywords: `mcp-server`, `claude-plugin`, `claude-skill`, `agent-skill`,
      `omp-plugin`, `oh-my-pi`
   6. GitHub code search for filename `.omp-plugin/marketplace.json` or
      `.claude-plugin/marketplace.json` — the blind-spot closer that finds
      catalogs you have not added
   7. Smithery — `smithery --json mcp search "<q>"`. Requires
      `SMITHERY_API_KEY`. **Skip this surface when the key is unset**; do not
      fail the skill.
3. If inventory covers the need, recommend the existing package and stop.
4. Verify serious candidates before recommending:
   - source repository, maintainer, license, and activity
   - actual `SKILL.md`, agent prompt, MCP manifest, or tool schema
   - required binaries, package managers, API keys, OAuth, network, and writes
   - destructive tools, secret handling, telemetry, and install scripts
   - overlap with already-installed plugins and MCP servers
5. Classify each candidate with the decision vocabulary below.

## Rules

- Install-mutating commands (`npx skills add`, `smithery mcp add`,
  curl-pipe-shell, registry copy/paste installs) are **trial-only after
  explicit approval**. They are never part of discovery.
- Registry pages are discovery sources, not sufficient verification.
- Do not treat an empty `omp plugin discover` as a closed search.

## Output

Lead with one decision: `Use existing`, `Adopt`, `Trial`, `Reject`, or `Build`.
Then list searched surfaces, shortlisted candidates, verification notes,
overlap, install path, and caveats.

Add a **decision-matrix row per candidate**:

| name | type | source URL | license | last activity | overlap with installed | install path | verdict |
