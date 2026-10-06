---
name: find-tools-no-install
description: Reminds that skill and MCP install commands are trial steps after explicit approval, never discovery.
condition: ["(?:^\\s*(?:(?:[^'\"\\\\]|\\\\[\\s\\S]|'[^']*'|\"(?:[^\"\\\\]|\\\\[\\s\\S])*\")*?(?:[;&|(\\n`]|\\b(?:then|do|else)\\s))?\\s*|^\\{(?:[^\"]|\"(?:[^\"\\\\]|\\\\.)*\")*?\"command\"\\s*:\\s*\"(?:(?:[^\"\\\\']|\\\\[^\"\\\\]|\\\\\\\\(?:\\\\.|[^\"\\\\])|'(?:[^'\"\\\\]|\\\\.)*'|\\\\\"(?:[^\"\\\\]|\\\\[^\"\\\\]|\\\\\\\\(?:\\\\.|[^\"\\\\]))*\\\\\")*?(?:[;&|(`]|\\\\n|\\b(?:then|do|else)\\s))?\\s*)(?:sudo\\s+(?:-\\S+\\s+)*)?(?:(?:npx|bunx|pnpm\\s+(?:-\\S+\\s+)*dlx|yarn\\s+dlx|npm\\s+(?:exec|x))\\s+(?:-\\S+\\s+)*)?(?:skills(?:\\x40\\S+)?\\s+(?:--\\s+)?add|(?:@smithery/cli|smithery)(?:\\x40\\S+)?\\s+(?:--\\s+)?(?:install|mcp\\s+add))\\b"]
scope: "tool:bash"
interruptMode: never
---
This command installs a skill or MCP server (`skills add`, `@smithery/cli install`, `smithery mcp add`). Discovery only reads and reports. Install a candidate only after the user approved that exact candidate, and only as a project-scoped trial.
