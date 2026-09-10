---
name: quality-sniff-analyzer-redirect
description: Redirects marked direct sniff analyzer commands to the atomic runner.
condition: ["(?m)(?:^|(?:&&|\\|\\||[;|&])\\s*)(?:env\\s+)?OMP_SNIFF_ACTIVE=1(?:\\s+[A-Za-z_][A-Za-z0-9_]*=\\S+)*\\s+(?:(?:command\\s+)?(?:\\S*/)?(?:semgrep|lizard|scc|sg|tokei|jscpd|trivy|checkov|gitleaks|cargo\\s+clippy|cargo-machete|cargo\\s+\\+nightly\\s+udeps|cargo\\s+geiger|golangci-lint|deadcode|go\\s+vet|staticcheck|gocyclo|gocognit|gosec|ruff|vulture|pylint|mypy|pyright|radon|xenon|deptry|bandit|eslint|tsc|knip|depcruise|type-coverage|madge|biome|svelte-check|vue-tsc|shellcheck|shfmt|sqlfluff|squawk|stylelint|css-analyzer|yamllint|taplo|check-jsonschema|vacuum|spectral|openapi-spec-validator|oasdiff|graphql-inspector|buf|protolint|hadolint|tflint|terraform|actionlint|zizmor|pinact|glab\\s+ci\\s+lint|kube-linter|kubeconform|markdownlint-cli2|lychee|cspell)(?=$|[\\s;&|<>()])|(?:npx(?:\\s+--no-install)?|bunx|pnpm\\s+exec|yarn\\s+exec)\\s+(?:--\\s+)?(?:jscpd|eslint|tsc|knip|depcruise|type-coverage|madge|biome|svelte-check|vue-tsc|stylelint|css-analyzer|spectral|graphql-inspector|markdownlint-cli2|cspell)(?:@[^\\s;&|<>()]+)?(?=$|[\\s;&|<>()]))"]
scope: "tool:bash"
interruptMode: never
---

This marked Bash command directly invokes a catalogued sniff analyzer. Use
`sniff_run_analyzer` with the canonical tool id, analyzer arguments, target root,
hosted packages, and accepted exit codes instead. The command-local marker only
signals active sniff context; it never makes direct execution valid coverage.
