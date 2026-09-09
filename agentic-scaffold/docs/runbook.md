# Runbook

## Greenfield

```bash
mkdir -p /tmp/example && git -C /tmp/example init
python3 skills/agentic-scaffold/scripts/scaffold.py inspect --root /tmp/example
python3 skills/agentic-scaffold/scripts/scaffold.py profiles list
python3 skills/agentic-scaffold/scripts/scaffold.py plan --root /tmp/example --profile agentic-repo --name example
python3 skills/agentic-scaffold/scripts/scaffold.py render --root /tmp/example --profile agentic-repo --name example
python3 skills/agentic-scaffold/scripts/scaffold.py tools install --root /tmp/example --yes
python3 skills/agentic-scaffold/scripts/scaffold.py hooks install --root /tmp/example
python3 skills/agentic-scaffold/scripts/scaffold.py plugins sync --root /tmp/example
just --directory /tmp/example check
omp plugin list --json
omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"
```

When beads is present, copy the appropriate formula into `.beads/formulas/`, then pour it with `bd mol pour mol-scaffold-greenfield --var feature=001-example --var profile=agentic-repo`. Resolve its interview and commit gates with `bd gate resolve <gate-id>` before closing the preceding step.

## Brownfield

```bash
python3 skills/agentic-scaffold/scripts/scaffold.py inspect --root /path/to/repo
python3 skills/agentic-scaffold/scripts/scaffold.py plan --root /path/to/repo --profile agentic-repo
# review the JSON map; exit 5 is a conflict
python3 skills/agentic-scaffold/scripts/scaffold.py render --root /path/to/repo --profile agentic-repo
python3 skills/agentic-scaffold/scripts/scaffold.py plugins sync --root /path/to/repo
python3 skills/agentic-scaffold/scripts/scaffold.py hooks install --root /path/to/repo
just --directory /path/to/repo check
omp plugin list --json
```

Do not overwrite an existing unmarked AGENTS.md, WATCHDOG.md, `.gitignore`, or hook config. Put local text outside managed markers and re-render; the renderer preserves it. The brownfield formula requires an inspection/classification gate before applying layers.

## Verification and cleanup

Run `plugins sync --check` after installation. It must return 0 and report an empty drift list. Check that `omp plugin list --json` reports `scope: project`. Fresh-session skill visibility requires `omp -p --no-session --model smol ...`; reload the session after a plugin install. Throwaway repositories used for live plugin tests must be removed after uninstalling their project-scope plugins.
