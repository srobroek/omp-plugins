# Render and update

LOAD when applying a plan or refreshing an installed scaffold.

```sh
python3 skill://agentic-scaffold/scripts/scaffold.py plan --root R --profile P --name N
python3 skill://agentic-scaffold/scripts/scaffold.py render --dry-run --root R --profile P --name N
python3 skill://agentic-scaffold/scripts/scaffold.py render --root R --profile P --name N
python3 skill://agentic-scaffold/scripts/scaffold.py update --root R
```

`render --dry-run` is exactly the `plan` operation and writes nothing. A normal render is idempotent: a second run has no file diff. It writes answers and metadata, creates owned files, and updates only managed marker blocks. Existing owned files are skipped. `--adopt PATH` moves a chosen existing file to `PATH.scaffold-orig` before rendering.

`update` reads the committed answers file and current installed plugin version. Managed blocks refresh. An owned file whose hash differs from the last render is reported as `drifted` and remains untouched. Text outside markers is preserved.

Exit codes: 0 success, 1 operational error, 2 drift/check failure, 5 conflict. Never use `--force-layer` or `--adopt` without reporting the decision in the review.

For a monorepo, render root layers first. Then render each member using its own variable scope. Member files are rooted below the recorded member directory. Managed blocks remain at the repository root.

```sh
python3 skill://agentic-scaffold/scripts/scaffold.py member list --root R
python3 skill://agentic-scaffold/scripts/scaffold.py member add --root R --name api --layer lang/python --kind app
python3 skill://agentic-scaffold/scripts/scaffold.py render --root R
```

`update` re-renders every recorded member. It reports drifted owned member files and leaves them untouched.
