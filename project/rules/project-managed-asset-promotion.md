---
name: project-managed-asset-promotion
description: Use when a machine-local managed skill or rule is reused across sessions and may need persistent OMP promotion.
---

# Promote Reused Managed Assets

Treat `~/.omp/agent/managed-skills` as machine-local source storage with no
remote. Treat this repository as the versioned, released source that installs
assets for other machines. Preserve that asymmetry: promote valuable steering
before it remains unversioned.

Promote a managed skill or rule when it has been loaded or referenced in more
than one distinct session, or when it has been cited in a landed change. Use
that observable threshold; do not wait for a subjective feeling of popularity.

Keep promotion deliberate. Propose it as an agent; have the maintainer choose
the destination plugin, land the change, and open the pull request. Do not run
promotion as a background job, cron task, or hook.

Run `python3 scripts/promote-managed-asset.py` with no arguments to list every
managed skill and whether a same-named asset exists in this repository. Then
perform a dry run for the named asset, selecting `--plugin` and `--kind`; use
`--topic` for a rule whose topic differs from its source name. Review the
reported paths, unchanged content, rule rename, and diff. Apply only after the
maintainer explicitly chooses adoption with `--apply`; use `--update` as a
separate explicit choice when the destination already exists.

Choose the destination plugin and the conventional-commit scope as human
decisions. Commit the adopted asset with a scoped subject such as
`feat(project): promote <asset>` so release-please cuts a release for that
package; an unscoped commit reaches no package and cuts no release. Open the
pull request separately.

Never delete or modify the managed source during promotion. Keep a promoted
asset in both stores; remove the managed copy only in a separate deliberate
step after checking that the harness no longer loads it from there.

Prevent the observed estate failure: today four skill sources sat untracked in
the managed store with no remote and no issue tracker, discovered only by a
git-status check in a directory nobody audited; two duplicated each other.
Do not assume another system tracks a managed asset.
