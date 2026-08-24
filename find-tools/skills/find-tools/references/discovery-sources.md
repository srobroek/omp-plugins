# Discovery Sources

Query in this order. Do not skip local inventory. Do not treat surface 2 as
exhaustive.

## Surfaces (query order)

1. **Local inventory** — what you already have.
   - `omp plugin list`
   - `omp plugin marketplace list`
   - `~/.omp/agent/mcp.json`
2. **`omp plugin discover [marketplace]`** — indexes **only catalogs already
   added** with `omp plugin marketplace add`. There is no global crawl. An
   empty result never means "nothing exists"; it means "nothing in the
   catalogs you already registered". Continue to later surfaces.
3. **Official MCP Registry** — anonymous read.
   `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=<q>&version=latest`
4. **vercel `skills` CLI** — `npx skills find <query>` (`--owner <org>`).
   Indexes public SKILL.md repos. No auth for public search.
5. **npm registry** —
   `GET https://registry.npmjs.org/-/v1/search?text=keywords:<kw>`
   Useful keywords: `mcp-server` (recall), `claude-plugin` / `claude-skill` /
   `agent-skill` (medium), `omp-plugin` / `oh-my-pi` (low volume, high signal).
6. **GitHub code search** — filename `.omp-plugin/marketplace.json` or
   `.claude-plugin/marketplace.json`. This is the blind-spot closer that finds
   **new catalogs** you have not added. Anonymous works; `GH_TOKEN` improves
   reliability.
7. **Smithery** — `smithery --json mcp search "<q>"` or
   `GET https://api.smithery.ai/servers?q=`. Requires `SMITHERY_API_KEY`.
   **Skip the entire surface when the key is unset**; do not fail the skill.

## Deliberately excluded

- Glama, PulseMCP, MCP.Directory, SkillsGate — HTML aggregators that overlap
  the Official MCP Registry and Smithery.
- Awesome-list READMEs — prose, scrape-only, high recall and low precision.
- `apm marketplace` — legacy inventory check only while APM packages still
  exist; never the primary surface.

## Install-mutating commands

`smithery mcp add`, `npx skills add`, curl-pipe installers, and similar
write-to-disk commands are **trial-only after explicit approval**. They are
never part of discovery.
