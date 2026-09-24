#!/usr/bin/env python3
"""Validate the Dependabot update policy against the pieces that depend on it.

Every fact this checks is invisible to YAML validation and to Dependabot itself:

- `ignore[].update-types` only accepts the semver-qualified spellings
  (`version-update:semver-minor`). The bare `minor`/`major` that `groups` accepts
  is silently not a match here, so an unqualified value quietly re-enables the
  OMP minor PRs this policy exists to suppress.
- The group name is a cross-file contract: dependabot-automerge.yml merges on
  `dependency-group == '<name>'`, so renaming the group in one file turns
  automerge into a no-op with nothing failing.
- Dependabot reads only the manifest in the directory it is pointed at, so a
  dependency-bearing plugin with no entry is simply never updated. The expected
  set of directories is derived from the committed lockfiles rather than written
  down, so adding a lockfile without an entry fails here.
- The root manifest is the single authority for the OMP version (bead
  omp-plugins-c0c): a version literal reintroduced into the loader smoke or into
  ci.yml lets the smoke certify a host nobody develops against, and five OMP pins
  that are not all the same version make "the OMP version" meaningless.
- The generated-dist automation is split into an unprivileged build on the pull
  request head and a privileged publication that runs default-branch logic only.
  Nothing fails if that split collapses back into one `pull_request_target` job
  holding a write token while it executes pull-request code.
- omp-minor-issue.yml reads the issue list and then creates an issue. Without
  serialized concurrency two runs both read "absent" and file the same issue.
- An unpinned action tag is a mutable reference: the tag can be moved onto new
  code after review.
- Renovate owned this job before and automerged every minor bump; a leftover
  renovate.json would put it back in charge alongside Dependabot.

Deterministic: reads committed files only, no network and no repository history.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent

DEPENDABOT = REPO / ".github/dependabot.yml"
AUTOMERGE = REPO / ".github/workflows/dependabot-automerge.yml"
DIST_BUILD = REPO / ".github/workflows/dependabot-dist-build.yml"
DIST_PUBLISH = REPO / ".github/workflows/dependabot-dist.yml"
MINOR_ISSUE = REPO / ".github/workflows/omp-minor-issue.yml"
CI = REPO / ".github/workflows/ci.yml"
SMOKE = REPO / "scripts/check-plugin-loading.ts"
MANIFEST = REPO / "package.json"
WORKFLOWS = REPO / ".github/workflows"

GROUP = "omp-patch"
ECOSYSTEM = "bun"
PATTERN = "@oh-my-pi/*"
SCOPE = "@oh-my-pi/"
HOST_PACKAGE = "@oh-my-pi/pi-coding-agent"
OMP_PACKAGES = {
    "@oh-my-pi/omptype",
    "@oh-my-pi/pi-agent-core",
    "@oh-my-pi/pi-ai",
    HOST_PACKAGE,
    "@oh-my-pi/pi-utils",
}
IGNORED_UPDATE_TYPES = {"version-update:semver-minor", "version-update:semver-major"}
BUILD_WORKFLOW_NAME = "dependabot-dist-build"
ARTIFACT = "dependabot-dist"
GUARD = "scripts/dependabot-dist-guard.py"
# Anything that turns published bytes back into executed code. The privileged job
# copies files and pushes; it never resolves, installs or evaluates them.
EXECUTION = ("bun install", "bun build", "bun run", "npm ", "npx ", "pip install", "build-extensions.py")
# A pinned exact version: no range operator, no wildcard, no tag.
EXACT_VERSION = re.compile(r"\A\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\Z")
# An @oh-my-pi package name followed by a version literal: the name may be quoted,
# `@`-suffixed or a JSON key, so the separators are skipped before the digits.
OMP_REFERENCE = re.compile(r"@oh-my-pi/[A-Za-z0-9._-]+")
TRAILING_VERSION = re.compile(r"\A[\s\"'@:=]*(\d+\.\d+\.\d+)")
USES = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<action>\S+)(?P<rest>.*)$")
PINNED = re.compile(r"\A[^@\s]+/[^@\s]+@[0-9a-f]{40}\Z")

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def load(path: Path) -> object:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        fail(f"{path.relative_to(REPO)}: does not parse as YAML: {error}")
        return None


def triggers(workflow: dict) -> object:
    """`on:` is YAML 1.1 truth, so PyYAML keys the trigger block under True."""
    return workflow.get("on", workflow.get(True))


def steps_of(workflow: dict) -> list[dict]:
    return [
        step
        for job in (workflow.get("jobs") or {}).values()
        if isinstance(job, dict)
        for step in (job.get("steps") or [])
        if isinstance(step, dict)
    ]


def executable_text(workflow: dict) -> str:
    """What the runner actually executes, with the prose that explains it removed.

    These checks forbid whole classes of command, so they have to read the steps
    rather than the file: a header comment that names `pull_request_target` to say
    the workflow no longer uses it is documentation, not a finding.
    """
    chunks: list[str] = []
    for step in steps_of(workflow):
        chunks.append(str(step.get("uses") or ""))
        chunks.append(json.dumps(step.get("with") or {}, sort_keys=True))
        chunks.append(json.dumps(step.get("env") or {}, sort_keys=True))
        chunks.append(str(step.get("if") or ""))
        chunks.extend(
            line for line in str(step.get("run") or "").splitlines() if not line.lstrip().startswith("#")
        )
    return "\n".join(chunks)


def expected_directories() -> dict[str, bool]:
    """Every directory Dependabot must watch, mapped to "needs OMP grouping".

    A committed bun.lock is the evidence that a directory has resolvable
    dependencies; an @oh-my-pi requirement in its manifest is the evidence that the
    OMP group and the minor/major suppression apply to it.
    """
    found: dict[str, bool] = {}
    for lock in [REPO / "bun.lock", *sorted(REPO.glob("*/bun.lock"))]:
        if not lock.is_file():
            continue
        manifest = lock.parent / "package.json"
        if not manifest.is_file():
            fail(f"{lock.relative_to(REPO)}: no package.json beside the lockfile")
            continue
        data = json.loads(manifest.read_text(encoding="utf-8"))
        requirements = {
            **(data.get("dependencies") or {}),
            **(data.get("devDependencies") or {}),
        }
        directory = "/" if lock.parent == REPO else f"/{lock.parent.name}"
        found[directory] = any(name.startswith(SCOPE) for name in requirements)
    return found


def check_omp_group(entry: dict, directory: str, label: str) -> None:
    groups = entry.get("groups")
    if not isinstance(groups, dict) or GROUP not in groups:
        fail(
            f"{label}: {directory} needs a group named {GROUP!r}; "
            "dependabot-automerge.yml merges on that exact name"
        )
    else:
        group = groups[GROUP] if isinstance(groups[GROUP], dict) else {}
        if list(group.get("patterns") or []) != [PATTERN]:
            fail(
                f"{label}: {directory} group {GROUP!r} patterns must be [{PATTERN!r}], "
                f"got {group.get('patterns')!r}"
            )
        if list(group.get("update-types") or []) != ["patch"]:
            fail(
                f"{label}: {directory} group {GROUP!r} must carry patch updates only, "
                f"got {group.get('update-types')!r}; anything wider would automerge unattended"
            )

    ignores = [i for i in (entry.get("ignore") or []) if isinstance(i, dict)]
    omp_ignores = [i for i in ignores if i.get("dependency-name") == PATTERN]
    if not omp_ignores:
        fail(f"{label}: {directory} needs an ignore entry for dependency-name {PATTERN!r}")
    for ignore in omp_ignores:
        types = set(ignore.get("update-types") or [])
        unqualified = {t for t in types if not str(t).startswith("version-update:")}
        if unqualified:
            fail(
                f"{label}: {directory} ignore update-types must be semver-qualified; "
                f"{sorted(unqualified)!r} never matches, so those updates stay enabled"
            )
        if types != IGNORED_UPDATE_TYPES:
            fail(
                f"{label}: {directory} ignore for {PATTERN!r} must be exactly "
                f"{sorted(IGNORED_UPDATE_TYPES)!r}, got {sorted(types)!r}"
            )


def check_dependabot() -> None:
    config = load(DEPENDABOT)
    label = DEPENDABOT.relative_to(REPO)
    if not isinstance(config, dict):
        return
    if config.get("version") != 2:
        fail(f"{label}: version must be 2, got {config.get('version')!r}")

    updates = config.get("updates")
    if not isinstance(updates, list) or not updates:
        fail(f"{label}: expected a non-empty updates list")
        return
    entries = [entry for entry in updates if isinstance(entry, dict)]
    if len(entries) != len(updates):
        fail(f"{label}: every update entry must be a mapping")
        return

    bun_entries = [entry for entry in entries if entry.get("package-ecosystem") == ECOSYSTEM]
    action_entries = [entry for entry in entries if entry.get("package-ecosystem") == "github-actions"]
    unknown = [
        str(entry.get("package-ecosystem"))
        for entry in entries
        if entry.get("package-ecosystem") not in {ECOSYSTEM, "github-actions"}
    ]
    if unknown:
        fail(f"{label}: unsupported package ecosystems {sorted(set(unknown))!r}")

    expected = expected_directories()
    covered = [str(entry.get("directory")) for entry in bun_entries]
    duplicates = sorted({d for d in covered if covered.count(d) > 1})
    if duplicates:
        fail(f"{label}: duplicate bun entries for {duplicates!r}")
    missing = sorted(set(expected) - set(covered))
    if missing:
        fail(
            f"{label}: no bun update entry for {missing!r}; those directories carry a bun.lock, "
            "so Dependabot never sees their dependencies"
        )
    extra = sorted(set(covered) - set(expected))
    if extra:
        fail(f"{label}: bun entries for {extra!r} have no bun.lock to resolve")

    if len(action_entries) != 1:
        fail(
            f"{label}: expected exactly one github-actions entry for /, "
            f"found {len(action_entries)}"
        )
    else:
        action_entry = action_entries[0]
        if str(action_entry.get("directory")) != "/":
            fail(
                f"{label}: github-actions directory must be '/', "
                f"got {action_entry.get('directory')!r}"
            )
        schedule = action_entry.get("schedule")
        interval = schedule.get("interval") if isinstance(schedule, dict) else None
        if interval != "daily":
            fail(f"{label}: github-actions schedule.interval must be 'daily', got {interval!r}")
        if action_entry.get("groups") or action_entry.get("ignore"):
            fail(f"{label}: github-actions entry must not define groups or ignore rules")

    for entry in bun_entries:
        directory = str(entry.get("directory"))
        schedule = entry.get("schedule")
        interval = schedule.get("interval") if isinstance(schedule, dict) else None
        if interval != "daily":
            fail(f"{label}: {directory} schedule.interval must be 'daily', got {interval!r}")

        if expected.get(directory):
            check_omp_group(entry, directory, str(label))
        elif directory in expected:
            # Grouping only where it is relevant: the group is automerge clearance,
            # so a directory with no OMP dependency must not carry it.
            if entry.get("groups"):
                fail(
                    f"{label}: {directory} declares groups but requires no {SCOPE}* package; "
                    f"the {GROUP!r} group is dependabot-automerge.yml's clearance and would "
                    "extend it to unrelated bumps"
                )
            if entry.get("ignore"):
                fail(
                    f"{label}: {directory} declares ignore rules but requires no {SCOPE}* package"
                )


def check_automerge() -> None:
    """The merge step itself must be gated, not merely mentioned in a comment."""
    if not AUTOMERGE.exists():
        fail(f"{AUTOMERGE.relative_to(REPO)}: missing, so the grouped patch PRs never merge")
        return
    workflow = load(AUTOMERGE)
    if not isinstance(workflow, dict):
        return

    label = AUTOMERGE.relative_to(REPO)
    # `pull_request_target` with write scope: safe only because the job never
    # materialises the pull request's code.
    for step in steps_of(workflow):
        if "checkout" in str(step.get("uses") or ""):
            fail(
                f"{label}: must not check out the pull request; it runs with "
                "pull_request_target write scope"
            )
    steps = [step for step in steps_of(workflow) if "gh pr merge" in str(step.get("run") or "")]
    if len(steps) != 1:
        fail(f"{label}: expected exactly one `gh pr merge` step, found {len(steps)}")
        return
    step = steps[0]

    if "--auto" not in str(step["run"]):
        fail(
            f"{label}: the merge step must pass --auto so the required checks, "
            "not this workflow, decide whether a bump lands"
        )
    condition = str(step.get("if") or "")
    for gate in (f"dependency-group == '{GROUP}'", f"package-ecosystem == '{ECOSYSTEM}'"):
        if gate not in condition:
            fail(
                f"{label}: the merge step's `if` must gate on steps.metadata.outputs.{gate} "
                "to match .github/dependabot.yml"
            )


def check_dist_build() -> None:
    """The half that runs pull-request code must hold nothing worth stealing."""
    label = DIST_BUILD.relative_to(REPO)
    if not DIST_BUILD.exists():
        fail(f"{label}: missing; the dist rebuild has nowhere unprivileged to run")
        return
    workflow = load(DIST_BUILD)
    if not isinstance(workflow, dict):
        return
    if workflow.get("name") != BUILD_WORKFLOW_NAME:
        fail(f"{label}: name must be {BUILD_WORKFLOW_NAME!r}; dependabot-dist.yml triggers on it")

    on = triggers(workflow)
    keys = set(on) if isinstance(on, (dict, list)) else {str(on)}
    if keys != {"pull_request"}:
        fail(
            f"{label}: must trigger on pull_request only, got {sorted(map(str, keys))!r}; "
            "pull_request_target would give this job the repository's secrets"
        )

    permissions = workflow.get("permissions")
    if permissions != {"contents": "read"}:
        fail(f"{label}: top-level permissions must be exactly contents: read, got {permissions!r}")

    text = executable_text(workflow)
    if "secrets." in text:
        fail(f"{label}: references secrets; this job executes pull-request code")
    checkouts = [step for step in steps_of(workflow) if "checkout" in str(step.get("uses") or "")]
    if not checkouts:
        fail(f"{label}: expected a checkout step")
    for step in checkouts:
        if (step.get("with") or {}).get("persist-credentials") is not False:
            fail(f"{label}: the checkout must set persist-credentials: false")

    uploads = [step for step in steps_of(workflow) if "upload-artifact" in str(step.get("uses") or "")]
    if len(uploads) != 1:
        fail(f"{label}: expected exactly one upload-artifact step, found {len(uploads)}")
    elif (uploads[0].get("with") or {}).get("name") != ARTIFACT:
        fail(f"{label}: the artifact must be named {ARTIFACT!r}; dependabot-dist.yml downloads it")

    condition = " ".join(
        str(job.get("if") or "") for job in (workflow.get("jobs") or {}).values() if isinstance(job, dict)
    )
    for gate in ("dependabot[bot]", "head.repo.full_name == github.repository"):
        if gate not in condition:
            fail(f"{label}: the job `if` must gate on {gate}")


def check_dist_publish() -> None:
    """The half that holds the write token must run default-branch logic only."""
    label = DIST_PUBLISH.relative_to(REPO)
    if not DIST_PUBLISH.exists():
        fail(f"{label}: missing; nothing publishes the rebuilt bundles")
        return
    workflow = load(DIST_PUBLISH)
    if not isinstance(workflow, dict):
        return

    on = triggers(workflow)
    keys = set(on) if isinstance(on, (dict, list)) else {str(on)}
    if keys != {"workflow_run"}:
        fail(
            f"{label}: must trigger on workflow_run only, got {sorted(map(str, keys))!r}; "
            "only workflow_run resolves this file from the default branch"
        )
    elif list((on["workflow_run"] or {}).get("workflows") or []) != [BUILD_WORKFLOW_NAME]:
        fail(f"{label}: workflow_run.workflows must be [{BUILD_WORKFLOW_NAME!r}]")

    permissions = workflow.get("permissions") or {}
    writes = sorted(scope for scope, level in permissions.items() if str(level) == "write")
    if writes:
        fail(
            f"{label}: top-level permissions grant write on {writes!r}; the push uses the "
            "release App token, minted after the checks"
        )

    concurrency = workflow.get("concurrency")
    if not isinstance(concurrency, dict) or concurrency.get("cancel-in-progress") is not False:
        fail(f"{label}: needs concurrency with cancel-in-progress: false, got {concurrency!r}")

    text = executable_text(workflow)
    for command in EXECUTION:
        if command in text:
            fail(
                f"{label}: runs {command.strip()!r}; this job publishes bytes and must never "
                "execute the artifact or the branch it writes to"
            )
    for subcommand in ("event-branch", "verify-context", "verify-artifact", "apply"):
        if f"{GUARD} {subcommand}" not in text:
            fail(f"{label}: must run `{GUARD} {subcommand}`")

    order = steps_of(workflow)

    def index(predicate) -> int:
        return next((i for i, step in enumerate(order) if predicate(step)), -1)

    token = index(lambda s: "create-github-app-token" in str(s.get("uses") or ""))
    context = index(lambda s: "verify-context" in str(s.get("run") or ""))
    artifact = index(lambda s: "verify-artifact" in str(s.get("run") or ""))
    head = index(lambda s: "checkout" in str(s.get("uses") or "") and (s.get("with") or {}).get("token"))
    if -1 in (token, context, artifact, head):
        fail(f"{label}: expected a token step, both verify steps and a credentialed checkout")
        return
    if not context < artifact < token < head:
        fail(
            f"{label}: the write credential must be minted after both verify steps and before "
            f"the head checkout, got verify-context at {context}, verify-artifact at {artifact}, "
            f"token at {token}, checkout at {head}"
        )
    ref = str((order[head].get("with") or {}).get("ref") or "")
    if "steps.context.outputs.head-sha" not in ref:
        fail(
            f"{label}: the head checkout must use the verified commit id "
            f"(steps.context.outputs.head-sha), got {ref!r}"
        )


def check_minor_issue() -> None:
    label = MINOR_ISSUE.relative_to(REPO)
    if not MINOR_ISSUE.exists():
        fail(f"{label}: missing; nothing notices that this checkout fell behind an OMP minor")
        return
    workflow = load(MINOR_ISSUE)
    if not isinstance(workflow, dict):
        return

    concurrency = workflow.get("concurrency")
    if not isinstance(concurrency, dict):
        fail(
            f"{label}: needs a concurrency block; the dedupe reads the issue list and then "
            f"creates an issue, so two overlapping runs both file it, got {concurrency!r}"
        )
    else:
        group = concurrency.get("group")
        if not isinstance(group, str) or not group or "${{" in group:
            fail(
                f"{label}: concurrency.group must be a constant so every run serializes "
                f"against every other, got {group!r}"
            )
        if concurrency.get("cancel-in-progress") is not False:
            fail(
                f"{label}: concurrency.cancel-in-progress must be false; cancelling between the "
                f"dedupe read and the create loses the notice, got "
                f"{concurrency.get('cancel-in-progress')!r}"
            )

    text = executable_text(workflow)
    for fragment, reason in (
        ("set -euo pipefail", "an API error must abort rather than read as 'no such issue'"),
        ("--paginate", "`gh issue list --limit N` silently stops at N and refiles the issue"),
        ('has("pull_request") | not', "the /issues endpoint also returns pull requests"),
        ("grep -Fxq", "the dedupe must match the whole title literally"),
    ):
        if fragment not in text:
            fail(f"{label}: lost `{fragment}`: {reason}")


def check_manifest_authority() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    dev = manifest.get("devDependencies", {}) if isinstance(manifest, dict) else {}

    missing = OMP_PACKAGES - dev.keys()
    if missing:
        fail(f"package.json: missing @oh-my-pi devDependencies {sorted(missing)!r}")
    for name in sorted(OMP_PACKAGES & dev.keys()):
        version = dev[name]
        if not EXACT_VERSION.match(str(version)):
            fail(
                f"package.json: {name} must be an exact version so Dependabot's patch group "
                f"is the only thing that moves it, got {version!r}"
            )
    pinned = {name: str(dev[name]) for name in sorted(OMP_PACKAGES & dev.keys())}
    if not missing and len(set(pinned.values())) != 1:
        fail(
            f"package.json: the {len(OMP_PACKAGES)} {SCOPE}* pins must all be the same version, "
            f"got {pinned!r}; the loader smoke and the CI host read one of them and would "
            "certify a host the rest of the repository does not compile against"
        )

    for path in (SMOKE, CI):
        text = path.read_text(encoding="utf-8")
        for reference in OMP_REFERENCE.finditer(text):
            version = TRAILING_VERSION.match(text[reference.end() : reference.end() + 24])
            if version:
                fail(
                    f"{path.relative_to(REPO)}: hardcodes {reference.group(0)}@{version.group(1)}; "
                    "read the version from package.json instead, or the smoke certifies a host "
                    "nobody develops against"
                )
    if HOST_PACKAGE not in CI.read_text(encoding="utf-8"):
        fail(f"{CI.relative_to(REPO)}: must install the smoke host from the {HOST_PACKAGE} pin")


def check_action_pins() -> None:
    for workflow in sorted(WORKFLOWS.glob("*.yml")):
        label = workflow.relative_to(REPO)
        for number, line in enumerate(workflow.read_text(encoding="utf-8").splitlines(), start=1):
            match = USES.match(line)
            if not match:
                continue
            action = match.group("action").strip("'\"")
            if action.startswith("./"):
                continue
            if not PINNED.match(action):
                fail(f"{label}:{number}: {action} is not pinned to a 40-character commit id")
            elif not re.search(r"#\s*v\S+", match.group("rest")):
                fail(f"{label}:{number}: {action} needs a trailing `# v<version>` comment")


def check_renovate_removed() -> None:
    for leftover in (REPO / "renovate.json", REPO / ".github/workflows/renovate-dist.yml"):
        if leftover.exists():
            fail(
                f"{leftover.relative_to(REPO)}: still present; Renovate automerged every minor "
                "bump and would compete with the Dependabot policy"
            )


check_dependabot()
check_automerge()
check_dist_build()
check_dist_publish()
check_minor_issue()
check_manifest_authority()
check_action_pins()
check_renovate_removed()

if failures:
    for message in failures:
        print(f"FAIL {message}")
    sys.exit(1)
print(
    f"OK dependabot policy: group {GROUP!r}, ecosystem {ECOSYSTEM!r}, "
    f"{len(expected_directories())} watched directories, manifest is the OMP authority, "
    "publication is unprivileged-build plus trusted-publish"
)
