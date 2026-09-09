# Hooks

The hooks layer composes conventional commit validation, hygiene checks, and a local context refresh hook for post-commit, post-checkout, and post-merge. `hooks install` invokes `prek install` for declared stages without `--force`. Existing unmanaged hook text stays untouched.
