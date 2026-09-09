# Verification

LOAD after rendering, plugin sync, hooks, or update.

```sh
python3 skill://agentic-scaffold/scripts/scaffold.py doctor --root R
python3 skill://agentic-scaffold/scripts/scaffold.py plugins sync --check --root R
just check
omp plugin list --json
```

`doctor` checks the answers and metadata files, required tools from every selected layer, installed declared hook stages when hooks were installed, project plugin sync, context status, and every managed marker pair. It exits 0 only when no errors or drift are found, 2 for drift, and 1 for an operational failure.

For a fresh-session proof, run `omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"` from the rendered project. Do not infer project-scope installation from user-scope plugin output.

After commits, checkouts, and merges refresh context. Keep the JSON report and the exact exit code in the handoff.
