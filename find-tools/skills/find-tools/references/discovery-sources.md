# Discovery Surfaces

Call `find_tools_scan` with the capability query. It reports the seven surfaces below; isolated failures never fail the tool.

## Surfaces

1. **local** — `omp plugin list`, `omp plugin marketplace list`, `~/.omp/agent/mcp.json`
2. **discover** — `omp plugin discover` over catalogs already added with `omp plugin marketplace add`
3. **mcp_registry** — Official MCP Registry search
4. **skills_cli** — unavailable in read discovery, including explicit selection; reports an approval-required gap without invoking `npx` or a local skills executable
5. **npm** — npm keyword search (`mcp-server`, `claude-plugin`, `claude-skill`, `agent-skill`, `omp-plugin`, `oh-my-pi`)
6. **github** — `gh api` code search for `.omp-plugin/marketplace.json` / `.claude-plugin/marketplace.json`
7. **smithery** — skipped when `SMITHERY_API_KEY` is unset

## Deliberately excluded

- Glama, PulseMCP, MCP.Directory, SkillsGate — HTML aggregators that overlap the Official MCP Registry and Smithery.
- Awesome-list READMEs — prose, scrape-only, high recall and low precision.
