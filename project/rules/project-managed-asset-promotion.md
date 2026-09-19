---
name: project-managed-asset-promotion
description: Use when a machine-local managed skill or rule is reused across sessions and may need persistent OMP promotion.
---

# Promote Reused Managed Assets

`~/.omp/agent/managed-skills` is machine-local with no remote, so an asset there
exists once and is lost with the directory. This repository is versioned,
released per package, and installed on other machines. Promote valuable steering
across that gap rather than leaving it unversioned.

MUST promote a managed skill or rule once it has been loaded or referenced in
more than one distinct session, or cited in a landed change. Use that observable
threshold, not a judgement about popularity.

MUST keep promotion deliberate: an agent proposes, the maintainer lands it. The
result is a released artifact in someone else'"'"'s install. NEVER run promotion from
a cron job, hook, or background task.

## Find what is unpromoted

List the managed store and compare it against this repository:

```sh
ls ~/.omp/agent/managed-skills
git ls-files '"'"'*/skills/*/SKILL.md'"'"' '"'"'*/rules/*.md'"'"'
```

A name present in the first and absent from the second is a candidate. Check
`git -C ~/.omp/agent/managed-skills status --porcelain` too: an untracked asset
there is the most fragile of all, because it exists in no commit.

## Reshape before landing, not after

A managed asset was written for one machine during one incident. Promotion is
the moment to generalise it, and the reshaping decisions belong in the same pull
request as the promotion.

situation → choice

- names a hardcoded path, host, or repository → parameterise it, or state the
  assumption in the body
- documents one incident → rewrite as the general procedure, keeping the measured
  numbers that justify a threshold
- overlaps an existing asset → merge into it instead of promoting a second copy,
  and say which lines the loser contributed
- prose an agent reads every session → a steering rule, not a skill
- a procedure with triggers and a workflow → a skill
- deterministic steps with no judgement → a script or tool the skill invokes
- guidance that must block a tool call → an extension gate, since a rule cannot
  enforce

See `skill://omp-surface-choice` for the surface decision and
`skill://write-agentic` for the template and format rules the promoted asset MUST
satisfy. Run `agentic_lint` on the destination directory before committing.

## Land it

The destination plugin and the commit scope are human decisions. Commit with a
scoped subject such as `feat(project): promote <asset>`; an unscoped subject
reaches no package, so release-please cuts no release and no install changes.

NEVER delete or modify the managed source while promoting. A promoted asset
lives in both stores; remove the managed copy only as a separate step, after
confirming the harness no longer loads it from there.

Measured failure this prevents: four complete skill sources sat untracked in the
managed store, with no remote and no issue tracker, found only by a git status in
a directory nobody audited. Two of them duplicated each other.
