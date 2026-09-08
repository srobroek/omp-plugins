# project

Set up existing repositories and author, validate, and maintain user journeys.

## Skills

- `brownfield-project`: retrofit an existing repository with agentic tooling
- `license-picker`: select an OSI-approved license from constraints
- `journey-init`: scaffold a `user-journeys` directory
- `journey-write`: author or amend journeys from feature evidence
- `journey-verify`: validate journeys against the running product
- `journey-verify-changed`: validate only journeys affected by a diff
- `journey-campaign`: fleet-scale journey validation
- `journey-consolidate`: flush delta logs and regenerate the journey index

## Agents

- `journey-scribe`: writes and amends journey documents; never drives the product
- `journey-validator`: drives one journey end to end and records a run

## Tools

The plugin's extension modules register:

- `journey_install_formulas`: preflights both bundled formulas and rejects symlink
  paths and divergent destinations. `force=true` permits overwriting only
  divergent formula files selected for this installation.
- `journeys_index`: index, structural lint, and prune. Lint does not assess
  semantic readiness or prove that a journey passes against the product.
  Prune requires a nonnegative safe integer `keep`; deletion requires `yes=true`.
  Select one journey directory with `journey` (CLI: `--journey`). Omitting
  the selector prunes every journey and requires directory-wide approval.

Validators own per-journey runs and finding payloads. The coordinator alone
updates shared INDEX.md/TRACKER.md and commits journeys-dir changes per wave.
Filesystem safety checks are preflight checks, not concurrent-writer locks.
