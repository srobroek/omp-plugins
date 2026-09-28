---
name: aws-skill-first
description: Reminds once when a bash call first runs the AWS CLI, CDK, or SAM to check the AWS MCP Server for a guided skill.
condition: ["(?:^|[\\s;&|(\"])(?:aws\\s+[a-z0-9][a-z0-9-]*\\s+[a-z0-9]|cdk\\s+(?:deploy|synth|diff|bootstrap|destroy)\\b|sam\\s+(?:build|deploy|sync|validate)\\b)"]
scope: "tool:bash"
interruptMode: never
---

This command drives AWS directly. If no AWS skill is loaded for this task, search `aws-mcp` with `aws___search_documentation` and `topics: ["agent_skills"]`, then load the match with `aws___retrieve_skill` before the next AWS step.
