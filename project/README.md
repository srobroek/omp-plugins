# project

Set up existing repositories and author, validate, and maintain user journeys.

## Skills

- `brownfield-project`: retrofit an existing repository with agentic tooling
- `agentic-scaffold`: scaffold a project's agent tooling
- `license-picker`: select an OSI-approved license from constraints
- `journey-init`: scaffold a `user-journeys` directory
- `journey-write`: author or amend journeys from feature evidence
- `journey-verify`: validate journeys against the running product
- `journey-verify-changed`: validate only journeys affected by a diff
- `journey-campaign`: fleet-scale journey validation
- `journey-consolidate`: flush delta logs and regenerate the journey index

## Agentic scaffolding

Run `/agentic-scaffold` in a Git repository to configure its agent tooling.
The skill inspects the repository and proposes a scoped installation.
It updates agent instructions and watchdog notes without replacing content outside
its managed sections.

The installation adds Graphify's Agents-platform skill and a Graphify MCP server
for the project. It also generates a scoped `repomix.xml`.
After commits, checkouts, and merges, prek refreshes the ignored graph and XML.
Existing hook entries and legacy scripts remain.
Graphify uses local code extraction by default. Semantic document indexing requires
an explicitly approved backend and model.

Use Graphify for repository relationships and impact questions. Use source reads
and LSP for exact edits, and Repomix for bulk review of the selected files.
The skill does not scaffold application code or initialize a task database.

## Agents

- `journey-scribe`: writes and amends journey documents; never drives the product
- `journey-validator`: drives one journey end to end and records a run

## Tools

The plugin's extension modules register:

- `agentic_scaffold`: inspect or apply repository agent tooling with explicit
  source include patterns and evidence-derived project notes.
- `journey_install_formulas`: preflights both bundled formulas and rejects symlink
  paths and divergent destinations. `force=true` permits overwriting only
  divergent formula files selected for this installation.
- `journeys_index`: index, structural lint, and prune. Lint does not assess
  semantic readiness or prove that a journey passes against the product.
  Prune requires a nonnegative safe integer `keep`; deletion requires `yes=true`.
  Select one journey directory with `journey` (CLI: `--journey`). Omitting
  the selector prunes every journey and requires directory-wide approval.

Each validator records its journey's run and findings. The coordinator alone
updates shared INDEX.md/TRACKER.md and commits journeys-dir changes per wave.
Filesystem safety checks are preflight checks, not concurrent-writer locks.
