---
name: aws-guidance
alwaysApply: true
---

AWS work in this project goes through the `aws` plugin's MCP servers.

- Before an AWS task, search `aws-mcp` with `aws___search_documentation` and `topics: ["agent_skills"]`. Load a match with `aws___retrieve_skill`, passing `skill_name` exactly as returned, and follow it over general knowledge.
- Verify AWS API parameters, permissions, limits, error codes, and regional availability against `aws-mcp` documentation tools. State what stayed unconfirmed.
- Price estimates with `aws-pricing`, and state the region, usage assumptions, and price-list date.
- Project instructions win over this guidance, including the project's infrastructure-as-code tool.
- Load the `aws-secrets-manager` skill before any secret, credential, API key, token, or password task. Never call `secretsmanager get-secret-value` or `batch-get-secret-value`.
- Use hyphens, not em dashes, in AWS resource names and descriptions.
