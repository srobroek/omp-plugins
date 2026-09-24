---
name: beads-ledger
description: Apply the Beads preferences that bd prime does not state, covering batched creation, graph plans, and embedded-store write safety.
---

`bd prime` is the single source of truth for `bd` commands and the default
workflow. Run it once per session and follow it. This rule states only the
preferences it does not cover, and it OUTRANKS `bd prime` on the two points
below where they disagree.
# REVIEW ACCEPTANCE
MUST set acceptance criteria at creation for every bead that will be reviewed, using `bd create ... --acceptance "CRITERIA"` or the graph-plan `acceptance_criteria` field. Judge completeness against those criteria; a reviewed bead without criteria cannot be judged complete.

# METADATA
MUST put useful facts in bead `metadata`, not comments or the description, including git anchors (`repo`, `branch`, `base_sha`, `worktree`, `pr`, `merge_sha`). Keep rationale in the description.

# MULTILINE TEXT
MUST pass multiline bead text through a file: `bd create|update ... --body-file notes.md` (or `--stdin`) for a description, `bd comments add ID --file notes.md` for a comment. A `\n` inside a quoted argument is stored as a literal backslash-n, not a paragraph break. The embedded-write gate accepts the `--body-file` form.

# WISPS
NEVER use wisps for durable agent-to-agent decisions, acceptance evidence, or closure. Use a durable bead carrier instead.

# BATCHED CREATION
MUST create more than one bead in a single `bd create --graph plan.json` call.
NEVER loop plain `bd create`, and NEVER fan `bd create` out across parallel
subagents. `bd prime` recommends exactly that fan-out; it is wrong here for two
independent reasons. Each invocation is its own transaction and its own Dolt
commit, which `bd batch --help` describes as severe write amplification, and
parallel writers against an embedded store corrupt the Dolt journal. One
measured session issued 37 separate `bd create` calls and 27 separate
`bd dep add` and `bd dep remove` calls among 122 `bd` invocations.

# GRAPH PLAN SCHEMA
`bd create --graph` is the only batched path that carries the fields this
steering requires. Its verified plan shape:

- Top level is `nodes`, plus an optional `edges`. A top-level `issues` key is
  silently dropped with a warning.
- A node's plan-local identifier is `key`, never `id`; a node without `key`
  is rejected. Accepted node fields are `key`, `type`, `priority`, `title`,
  `description`, `acceptance_criteria`, `parent_key`, `parent_id`, `labels`,
  `metadata`.
- The field is `acceptance_criteria`. Plain `acceptance` is silently dropped.
- To attach a newly-created node to an existing parent bead, use the node-level
  `parent_id` field with that bead's id. `parent_key` only names another node
  in the same plan; it fails when it names an existing bead. A dry run with an
  existing parent reported `23 parent-child link(s)` when `parent_id` was used,
  while putting that id in a top-level `from_id`/`to_id` edge reported
  `23 edge(s) (0 parent-child link(s))`.
- Dependencies between plan nodes belong in the top-level `edges` array, each
  entry `{"from_key": "a", "to_key": "b", "type": "blocks"}`. Use `from_id`
  and `to_id` to reference an existing bead when creating a dependency that is
  not a parent attachment.
- Unknown fields anywhere are silently dropped with a warning, so a typo costs
  the field rather than raising.

Verified fixture showing an existing parent (`parent_id`), a plan-local parent
(`parent_key`), and a dependency edge together:

```json
{
  "nodes": [
    {"key": "child", "parent_id": "omp-plugins-m8tf", "type": "task", "title": "Child"},
    {"key": "part", "parent_key": "child", "type": "task", "title": "Part"}
  ],
  "edges": [{"from_key": "part", "to_key": "child", "type": "blocks"}]
}
```

The fixture keeps the dependency in the top-level `edges` array; a per-node
`deps` array is not equivalent.

MUST review a graph plan before the implementation wave starts. The reviewer
MUST record a verdict against each guard rail: every task names bounded files or
symbols and independently verifiable acceptance criteria; design decisions are
separate decision or research beads; review beads depend on every task they
review; dependencies encode true ordering only; each implementer has a
justified `metadata.tier`; and the plan has an explicit integration/delivery
path. A failed guard rail produces a revision bead or blocks the implementation
wave; it is not silently accepted.

MUST dry-run first and check the reported node and edge counts, for example
`would create 3 issue(s) and 1 edge(s) (2 parent-child link(s))`. That count is
the only signal that catches the dropped-dependency trap. A dry run validates
structure only: a live create can still reject parent-child blocking paths after
resolving stored dependencies.

MUST treat a per-node `deps` array as a trap. It reports success and creates
ZERO edges, so the plan looks correct and the DAG has no dependencies at all.

# BULK MUTATION
Use `bd batch` for mutations of existing beads. First filter candidates with
`bd list`, `bd ready`, or `bd query`. Then render one grammar line per selected ID
and pass those lines to one `bd batch` transaction. Use graph creation for fields
that the batch `create` form cannot carry.

## Grammar

Each non-empty input line is one operation. The parser ignores lines beginning
with `#` and blank lines. Supported lines are:

```text
close <id> [reason...]
update <id> <key>=<value> [...]
create <type> <priority> <title...>
dep add <from> <to> [type]
dep remove <from> <to>
```

`update` accepts these keys:

- `status`
- `priority`
- `title`
- `assignee`
- `force`

Use double quotes for values containing spaces. The `force` key is a closure
override, not a persisted bead field. `dep add` defaults to `blocks`. When you
need a different relationship, pass a supported type such as `related` or
`parent-child`.

The input may come from stdin, `bd batch -f operations.txt`, or an inline
`printf` pipe. Every operation runs in one transaction. If any line fails, bd
returns a non-zero status and rolls back every earlier line in that batch.

## Filtering before batching

Use a read command to select IDs. Generate only the narrow mutation lines.
Scratch tests on bd 1.3.0 produced these forms:

```sh
# Close stale open items selected from human-readable list output.
bd list --status open -q |
  awk '/stale/ {print "close", $2, "stale filtered"}' |
  bd batch

# Return reclaimed in-progress items to the implementer pool.
bd list --status in_progress -q |
  awk '/reclaim/ {print "update", $2, "assignee=pool:implementer", "status=open"}' |
  bd batch

# Normalize priority for every open item at P2 or lower using JSON selection.
bd query 'status=open AND priority>=2' --json |
  jq -r '.[].id' |
  awk '{print "update", $1, "priority=1"}' |
  bd batch

# Add a typed dependency between the first two ready IDs.
bd ready --json |
  jq -r '.[].id' |
  awk 'NR == 1 {source=$1; next} NR == 2 {print "dep add", source, $1, "related"; exit}' |
  bd batch
```

The filters select IDs at runtime. When titles or reasons contain whitespace,
quote those values. If text output can make field boundaries ambiguous, use
`--json` with `jq`.

## Capability boundary

| Operation | `bd batch` result | Use instead |
|---|---|---|
| Close with a reason | Supported: `close ID reason...` | -- |
| Update fields | Supported for the five keys listed above | -- |
| Create fields | Supported for `type`, `priority`, and `title` | -- |
| Add or remove dependencies | Supported, including typed `parent-child` edges | -- |
| Comments and blank lines | Ignored; they do not add issue comments | `bd comment` or `bd comments add` |
| Issue comments | Unsupported `comment` command | `bd comment` or `bd comments add` |
| Metadata, labels, description, or acceptance | Unsupported update keys | `bd update`/`bd create` flags or graph-plan fields |
| Claim | Unsupported; `--claim` is not a batch update key | `bd update ID --claim` |
| Direct parent field | Unsupported `parent=...` update | `dep add FROM TO parent-child` or graph-plan `parent_key` |
| Read commands | Unsupported batch commands | Filter with `bd list` or `bd query` before batching |

`bd batch -f` reads one file instead of stdin. It does not change the command
set or the transaction boundary.

# EMBEDDED STORE
The store is embedded and lives in the canonical checkout, and linked worktrees
share it. `BEADS_DIR` does not redirect `bd init` away from canonical. No Dolt
server may be started. Two concurrent writers corrupt the Dolt journal, so a
contended `bd` call is retried rather than worked around.
# DELIVERY
MUST run `bd dolt pull` before claiming when the read decides assignment, so the
claim uses fresh ledger state. After delivery, MUST run `bd dolt push`.

`bd dolt pull` and `bd dolt push` are bounded persistence operations, not locks.
Retry each failed sync up to three attempts with a brief wait, then report the
verbatim failure. Never fall back to a manual `dolt` invocation, start a server,
or continue as though the remote were current. If the final attempt may have
applied remotely but its result is unknown, report the sync as UNKNOWN and do
not claim that the ledger is synchronized. Re-run `bd dolt pull` before trusting
a read that decides assignment after any retry sequence.

Before any implementation wave, the lead records the DAG review verdict and
guard-rail evidence on the governing bead. The review must name the plan,
nodes, edges, tier justifications, and any revision or blocking decision; a
missing review is not a pass.
