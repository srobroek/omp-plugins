# Plugins

Plugin discovery and installation is the final topic. It is project-scoped by default: the
repository's configuration is the durable record, while user-scope marketplace registration,
trust, credentials, and machine-global configuration remain human-owned decisions.

## Asked

| Question | Default | Notes |
|---|---|---|
| Install scope | project | Use project scope unless the user explicitly asks for a user-scope marketplace registration. |
| Plugin package | none | Run `omp plugin discover`; read the active names, versions, categories, and descriptions back. |

A missing prerequisite stops the topic. Do not infer language support from a plugin name. Match the
exact package name and category; use the description only to review candidates. Do not name a
marketplace, registry, or plugin source the user did not name.

## Project-scope installation

1. Run `omp plugin discover` and read the active names, versions, categories, and descriptions.
2. Confirm the exact package name and category with the user.
3. Install with `omp plugin install <package> --project`.
4. Verify with `omp plugin list --json`.

Never claim that the current session loaded a newly installed capability. Provider changes require
a fresh session.

## User-scope registration

A user-scope install is a separate, machine-global decision. Ask before registering a marketplace,
trusting it, or supplying credentials. The user owns the marketplace registration, trust decision,
credentials, and global configuration; do not write those values into the repository plan.

If any prerequisite is missing, stop and report the gap rather than guessing or installing from an
unnamed source.
