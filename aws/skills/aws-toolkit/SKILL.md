---
name: aws-toolkit
description: Routes AWS work through the AWS MCP Server's guided skills, documentation, and pricing tools. Triggers on AWS, S3, CloudFront, Lambda, IAM, CDK, CloudFormation, or "AWS cost estimate".
---

# AWS Toolkit

TRIGGER
+ building, deploying, configuring, or troubleshooting anything on AWS
+ "which AWS service", "AWS cost estimate", "is this available in REGION"
+ an AWS error code, IAM denial, quota, or API parameter question
- Terraform provider syntax with no AWS behaviour question → the project's IaC docs
- AWS account, credential, or console steps only a human can do → `skill://wizard`

GATES
ASK before any AWS call that creates, changes, or deletes a resource. `aws-mcp` runs `--read-only`, so a write needs the user's explicit go-ahead and a separate route.
ASK which account and profile to use when the project does not name one. Never guess the target account.

## Workflow

1. Search for a guided skill first: `aws___search_documentation` with `topics: ["agent_skills"]` and the task's services and verbs → note each result's `skill_name`.
2. Load the best match with `aws___retrieve_skill`, passing `skill_name` verbatim. Load a cited `file` only when the skill body points to it → the skill's procedure replaces general knowledge for this task.
3. No matching skill → search documentation with the narrowest topic (`reference_documentation`, `troubleshooting`, `cloudformation`, `cdk_docs`, `current_awareness`, `general`) and answer from the returned `context`.
4. Region questions → `aws___get_regional_availability` or `aws___list_regions`, never memory.
5. Cost questions → `aws-pricing`: `get_pricing_service_codes`, then `get_pricing_service_attributes` and `get_pricing` for the named region; `analyze_terraform_project` or `analyze_cdk_project` for IaC → state the region, usage assumptions, and price-list date in the estimate.

## Rules

MUST Let project instructions win where they conflict with this skill, including the project's IaC tool.
MUST Verify API parameters, permissions, limits, and error codes against documentation; state what stayed unconfirmed.
MUST Load the `aws-secrets-manager` skill before any secret, credential, API key, token, or password task.
MUST Copy `skill_name` and `file` values exactly as search returned them.
DEFAULT Create infrastructure through the project's infrastructure-as-code, not ad hoc CLI calls.
DEFAULT Apply the AWS Well-Architected Framework pillars to infrastructure decisions.
NOT Calling `secretsmanager get-secret-value` or `batch-get-secret-value`: the secret value lands in context.
NOT Quoting a free-tier allowance or price from memory as current.
NOT Em dashes in AWS resource names or descriptions; use hyphens.
