# Steering index

One directory per concern. Read the index, then the leaf for the language being touched.

| Concern | Directory |
|---|---|
| What each quality tool enforces | `quality/` |
| Job graph and merge gates | `ci/` |
| Version source and publish targets | `release/` |
| Test layout and invocation | `testing/` |
| Where docs live and how they deploy | `docs/` |
| Required environment variables | `env/` |
| Error handling, naming, ownership | `conventions.md` |

<!-- BEGIN GENERATED: index -->
<!-- END GENERATED: index -->

## Using the recipes

For a monorepo, use the accepted member paths and the recipe already provided by that member's
language asset. Creating a member by hand does not register it anywhere; update the accepted
member map and add the member's bounded fragments explicitly.

For a polyrepo, run the setup independently in each checkout. Ask before reusing a related
repository's topology, host, forge, stack, release, or governance choices.

Run `just steering` after changing configuration that a generated block reads. CI fails on
steering drift.

Run the relevant root or member recipe before claiming a change works. A tree that renders is
not a project that builds.
