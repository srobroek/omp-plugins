# aws

Use this plugin to give OMP the AWS MCP Server, the AWS Pricing MCP server, and the `aws-toolkit` skill.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install aws@srobroek-omp
```

Start a new session after installing. `omp plugin list` then reports `aws@srobroek-omp`.

## Prerequisites

- `uv` on `PATH`. Both servers start through `uvx`.
- AWS credentials in the default credential chain for authenticated calls. Set `AWS_PROFILE` before starting OMP to select a profile. `aws login` sessions work.

## MCP servers

| Server | Command | Scope |
|---|---|---|
| `aws-mcp` | `uvx mcp-proxy-for-aws-cli@latest https://aws-mcp.us-east-1.api.aws/mcp --read-only --skip-auth` | AWS documentation search, guided AWS skills, regions, and regional availability |
| `aws-pricing` | `uvx --with botocore[crt] awslabs.aws-pricing-mcp-server@latest` | AWS Price List queries and Terraform or CDK cost analysis |

`aws-mcp` runs with `--read-only`, which hides every tool that can change AWS resources. `--skip-auth` lets documentation and skill tools work without credentials.

`aws-pricing` queries the Price List API in `us-east-1`. The `botocore[crt]` extra loads credentials created by `aws login`.

OMP names the marketplace entries `aws:aws-mcp` and `aws:aws-pricing`. To change a server's flags, add a native entry to `~/.omp/agent/mcp.json` or the project's `.omp/mcp.json`. Then hide the plugin entry in the user file:

```json
{
  "disabledServers": ["aws:aws-mcp"]
}
```

## Skill

`aws-toolkit` tells the agent to search `aws-mcp` for a guided AWS skill before acting. It then has the agent verify details against AWS documentation and price with `aws-pricing`. It adapts the rules file from [Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws/blob/main/rules/aws-agent-rules.md) (Apache-2.0).

## Data handling

`aws-mcp` sends queries to the AWS-hosted endpoint. Authenticated calls appear in CloudTrail for the signing account.
