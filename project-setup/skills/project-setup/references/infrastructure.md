# Infrastructure

When infrastructure enters scope, load this reference.

## Choice boundary

Default to OpenTofu for shared infrastructure. When application code and AWS constructs share a
lifecycle or domain model, offer `AWS_CDK_TYPESCRIPT`. This package implements AWS CDK v2 with
TypeScript. For unsupported CDKs, record an `ACCEPTED_GAP`.

Ask one exclusive choice:

- `OPENTOFU`
- `AWS_CDK_TYPESCRIPT`
- `NO_INFRASTRUCTURE_CODE`

## AWS CDK frontier

When the user selects `AWS_CDK_TYPESCRIPT`, settle:

1. Destination: a new repository-relative member. Recommend `infra`.
2. CDK CLI: an exact stable `aws-cdk` version.
3. Environment model: environment-agnostic synthesis or explicit account and region sources.
4. Context lookups: disabled by default so CI synthesis needs no AWS session.
5. Stack boundaries: one named stack per independently deployed lifecycle.
6. Deployment authority: the setup run never bootstraps or deploys.

Do not ask for AWS credentials, account secrets, or session tokens. Account IDs and regions may come
from accepted environment variables or deployment configuration. Any command that calls `cdk
bootstrap` or `cdk deploy` is a separate consequential action and needs point-of-risk confirmation.

## Generator

Asset set: `skill://project-setup/assets/infrastructure/aws-cdk/`

Reject an existing destination. Copy `scripts/init_aws_cdk.py` byte for byte. Run this approved
command from the repository root:

```sh
python3 scripts/init_aws_cdk.py --dest '<destination>' --cdk-version '<X.Y.Z>'
```

The script validates the destination and exact version. It runs the native generator:

```sh
bunx --package 'aws-cdk@<X.Y.Z>' cdk init app --language typescript --generate-only
```

The script creates `bun.lock` with `bun install`. It atomically moves the generated member into
place. It never contacts AWS and contains no bootstrap or deploy path.

Render `.just.d/aws-cdk.just` with the destination quoted by Python `shlex.quote`. On GitLab, copy
the matching fragment. Copy the ignore fragment on every forge. GitHub CI finds the Just fragment
and runs install plus synthesis.

## Verification

1. Compare the copied generator and ignore fragment with their assets.
2. Run `just aws-cdk-install`.
3. Run `just aws-cdk-synth` without AWS credentials.
4. Confirm that the ignore file excludes `cdk.out/`.
5. Confirm that no generated app lookup needs AWS credentials.
6. Record these accepted choices in a decision record:
   - destination
   - version
   - environment model
   - stack boundaries
   - deployment authority

PASS needs all of these results:

- generated TypeScript CDK app
- committed lockfile
- credential-free synth
- recurring local and CI gate

An unimplemented provider, failed synth, or unresolved environment source is an `ACCEPTED_GAP` or a
blocking gap. Never report it as configured.
