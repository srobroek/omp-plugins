# AWS CDK validation without cloud mutation.

# Restore the generated CDK application from its committed lockfile
[group('infrastructure')]
aws-cdk-install:
    cd '/Users/sjors/tmp/worktrees/omp-plugins/omp-agent-omp-plugins-8o7o/.tmp-cdk-generator/infra' && bun install --frozen-lockfile

# Synthesize CloudFormation locally; never bootstrap or deploy
[group('infrastructure')]
aws-cdk-synth:
    cd '/Users/sjors/tmp/worktrees/omp-plugins/omp-agent-omp-plugins-8o7o/.tmp-cdk-generator/infra' && bun run cdk synth

# Aggregate used by just check
[group('infrastructure')]
aws-cdk: aws-cdk-synth
