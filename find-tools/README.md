# find-tools

Discover and vet reusable skills, agents, and MCP servers. Start with OMP-native discovery;
an empty `omp plugin discover` result does not prove that a capability is absent.

The read-approved discovery tool never acquires or executes the skills CLI package.
`skills_cli` remains a reported gap, including when explicitly selected; running it
requires separate explicit approval after vetting the package. No `npx` fallback runs.

Subprocesses retain at most 64 KiB combined output and have a 10-second deadline
plus at most one second of collection cleanup. Cancellation stops collection and
kills the POSIX process group (the direct child on Windows). Process-group termination
cannot reach detached descendants outside that group; collection still closes their pipes.

Local MCP inventory reports counts of configured, disabled, stdio, and remote servers.
It omits:

- server names
- commands
- URLs
- arguments
- environment variables
- headers
- parser diagnostics

## Skills

| Name | When |
|------|------|
| `find-tools` | Find a capability or decide adopt / reject / build |
