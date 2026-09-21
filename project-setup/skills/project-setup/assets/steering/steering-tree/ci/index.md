# CI

<!-- BEGIN GENERATED: ci-index -->
<!-- END GENERATED: ci-index -->

## Supported forge paths

GitHub uses the generated caller under `.github/workflows/`. GitLab uses the checked-in
`.gitlab-ci.yml` root include and `.gitlab/ci/*.yml` fragments.

Gitea, Azure DevOps, and other forges are explicit unsupported gaps. Do not treat a copied
GitHub workflow or GitLab pipeline as support for those forges.

## Member paths

A monorepo's CI jobs use the accepted member paths. A polyrepo runs its own checkout's jobs;
ask before reusing a related repository's CI or release choices.

## Notes

Hand-written text outside generated markers survives regeneration.
