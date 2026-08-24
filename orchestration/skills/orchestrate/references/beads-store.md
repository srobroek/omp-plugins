# Beads store: run state, mapping, audit, coordination

A run's DAG, node state, and audit trail live in the project's beads database
(the `bd` CLI). Every worktree shares one database, so agents in isolated
worktrees read/write live state with plain `bd` commands -- no shared-path
bookkeeping. Artifacts (full briefs/reports) are files under
`<primary>/.orchestration/run-<id>/artifacts/`. Bead comments reference them
by absolute path.

## Coordination and policy carriers

| Carrier | Stores | Authority |
|---|---|---|
| Work-bead comment | A choice that affects only that bead and its owned scope | The durable local truth. The comment author is the actor. Accepted comments remain. A provisional comment names an objective revisit trigger. |
| `decision` bead | A choice that affects a second bead, agent, or package, or constrains later work | The durable cross-boundary truth. It carries an owner, a stable key, a design, acceptance/verification, status/disposition. Each affected bead gets a non-blocking link. |
| Message wisp | Live coordination: a question, a reply, a notification, an acknowledgment | Ephemeral coordination only. Promote a material outcome to a comment or decision bead before action or closure. Neither acknowledgment nor compaction deletes the promoted truth. |
| Artifact / `output_ref` | A large inspectable payload of evidence: a brief, a report, a test log. A citing bead names its absolute path | Evidence only. A citing comment or decision bead joins it to a decision or report. Alone it is not policy or lifecycle state. |

A message counts as material when it changes any of these:

- a choice, default, or scope
- a route or ordering
- acceptance evidence or disposition
- a human answer

Handle it in this order:

1. Classify its effect as bead-local or cross-boundary.
2. Write the local comment or decision bead and any affected-bead links.
3. Read the durable record back. A decision is effective only after every
   affected link is visible and non-blocking.
4. Act from that record and cite it in later comments or reports.
5. Acknowledge or compact the message only after promotion succeeds.

No promotion means no policy action and no closure based on that message.
A restart puts comments and decision beads first in recovery. Message wisps and
artifacts come second.

## Local decision comments

Set `BEADS_ACTOR` to the choosing actor. Add this record to the work bead.
Before acting, read it back with `bd comments <bead> --json`:

```text
LOCAL_DECISION
owner: <actor>
scope: <work-bead and owned resource>
decision: <chosen implementation behavior>
rationale: <why this choice fits the brief>
evidence: <file:line, bead id, command result, or searched-none>
status: <accepted|provisional>
revisit: <objective trigger; required when provisional>
```

The comment author and `owner` must match. `accepted` omits `revisit`.
`provisional` requires one nonempty trigger:

- an event
- a dependency transition
- an exact evidence change
- an RFC3339 deadline

`later`, `if needed`, and elapsed time without an observable condition are not
triggers. Record the operation as `orc.note` in the audit trail.

A readable comment is the local truth. A failed audit write after a successful
comment needs a retry before closing, never a duplicate comment. A failed
comment write or read-back means the choice does not apply.

A cross-boundary choice needs a `decision` bead instead. Its creation contract,
edge-type rendering, and duplicate/supersession resolution are in
`references/decisions.md`; read that only when a choice leaves one bead's scope.

## Prerequisite (checked once, at run start)

```
command -v bd >/dev/null || { echo "orchestrate requires the beads CLI (bd)"; }
bd info >/dev/null 2>&1 || bd init --stealth --prefix orc
```

- No `bd` on PATH → stop and tell the user to install beads. No fallback store
  exists.
- `bd` present, no database → `bd init --stealth --prefix orc` (git-invisible:
  writes `.git/info/exclude`, leaves `git status` clean).

## Bead type vocabulary

| Type | Use |
|---|---|
| `epic` | architect domain / run root |
| `feature` | the grouping an architect creates, the natural PR + worktree unit |
| `task` | worker-sized unit |
| `bug` | mid-run defect, linked `discovered-from` its finder |
| `decision` | architecture decision record. The `adr` skill and `bd lint` already handle these |

Merge beads carry no type of their own. Readers identify them by the labels
`pr:merge` + `agent:integrator`, never by a type. `merge-request` is NOT adopted
as a bd type.

`bd` is internally inconsistent about types. An adopted vocabulary MUST stay
inside the `create`/`update` intersection, or `bd create` rejects the bead:

| Command | Accepted `-t` values |
|---|---|
| `bd create`, `bd update` | `bug feature task epic chore decision` |
| `bd ready` | those minus `chore`, plus `merge-request` |
| `bd list` | all of the above plus `molecule gate convoy` |

No code validates or enumerates this vocabulary. Review enforces it.

A wisp is not a type. It is `--ephemeral` plus `--wisp-type
{heartbeat,ping,patrol,gc_report,recovery,error,escalation}` plus a naming
convention, orthogonal to `issue_type`. The carrier table at the top of this
file defines only "Message wisp". The "worklog wisp" used elsewhere in this
package has no carrier row.

## Run and node beads

| Object | Beads representation |
|---|---|
| Run | one **epic** bead. Metadata `run_id` `primary_branch` `base_sha` `artifacts` (abs dir) with an optional `swarm` handle |
| DAG node | **task** bead with `--parent <epic>` plus label `orc-node`. Metadata `node` (short id) and `scope` (JSON array of globs) |
| Node dep | `bd dep add <dependent> <dependency>` (`blocks` type), one per edge |
| Runtime and Git anchors | activation-resource metadata, stamped per the contract below |

```
EPIC=$(bd create "orchestrate run-<id>" --type epic --silent \
  --metadata '{"run_id":"run-<id>","primary_branch":"main","base_sha":"<sha>","artifacts":"<abs>/.orchestration/run-<id>/artifacts"}')
# `bd swarm validate "$EPIC" --json` gates the structure and needs no marker.
# Only create a marker (`bd swarm create "$EPIC"`, handle -> metadata key `swarm`)
# when coordinator discovery or an external scheduler needs a durable handle.
T1=$(bd create "t1: <desc>" --parent "$EPIC" --labels orc-node --silent \
  --metadata '{"node":"t1","scope":["src/auth/**"]}')
bd dep add "$T3" "$T1"        # t3 depends on t1
bd dep cycles                 # must stay clean
```

The label MUST be `orc-node` (hyphen, plain label). `bd set-state` owns the
`state:` label dimension: each transition deletes the previous `state:<value>`
label, adds the new one, and emits an event bead -- the transition record.

## State mapping -- 11-state enum → bead status + `state:` label

Beads statuses are coarse and drive `bd ready`. The `state:` label carries the
review-round sub-state. One place per transition sets both:

```
bd set-state <bead> state=<name> --reason "<why>"     # label + event bead
bd update <bead> --status <status>                    # only where status changes
```

| Enum state | Bead status | `state:` label | Set by / how |
|---|---|---|---|
| `pending` | `open` | `state:pending` | orchestrator at `bd create` |
| `ready` | `open` | -- (derived, never stored) | `bd ready --label orc-node --parent <epic>` + clean `scope-check.py` |
| `working` | `in_progress` | `state:working` | architect: `bd update <bead> --claim` (atomic, first-wins, sets assignee) then `set-state` |
| `reported` | `in_progress` | `state:reported` | architect, after push |
| `in_review` | `in_progress` | `state:in_review` | orchestrator at reviewer spawn |
| `changes_requested` | `in_progress` | `state:changes_requested` | orchestrator on `REVIEW verdict=changes` |
| `approved` | `in_progress` | `state:approved` | orchestrator on `REVIEW verdict=approve` |
| `merged` | `closed` | `state:merged` | shepherd: `set-state` then `bd close <bead> --reason merged` |
| `dismissed` | `closed` | `state:dismissed` | orchestrator: `set-state` then `bd close <bead> --reason dismissed` |
| `failed` | `blocked` | `state:failed` | orchestrator: `set-state` then `bd update <bead> --status blocked` |
| `waiting_human` | `in_progress` | `state:waiting_human` | orchestrator on `ASK`. When the node has not started yet, add `bd gate create --type=human --blocks <bead>` |

Semantics that fall out of the status column:

- **Deps clear on `closed`.** A dependent becomes ready only once its
  upstreams are `merged`/`dismissed`.
- **Pick the type from what the dependent waits for.** `blocks` waits for the
  shepherd's merge, and the specialist already pushed the upstream's code at
  `reported`.
  - Needs the upstream CODE: use a non-blocking type and stamp
    `base_ref=<upstream branch>` on the dependent. The dependent then starts at
    the upstream's REPORTED push instead of its merge.
  - Needs the upstream DECISION to land first: keep `blocks`, which gates
    `bd ready`.
  - A `base_ref` dependent rebases when the upstream takes review changes. That
    rebase returns through the existing CONFLICT bounce-back path.
- **`failed` = `blocked` status** → never satisfies a dependency, never
  reappears in `bd ready`. Stranded downstream = `bd dep tree <bead>`.
- **`bd ready` excludes** gated beads, `in_progress`, `blocked`, `deferred`. The
  ready front is therefore dep-correct by construction.
- **Review handoff is one enforced field.** `rules-eval.py` evaluates
  `label ~ ^agent:reviewer$` on `reported`, and that label is the whole enforced
  contract. A cleared assignee and `status=in_progress` are convention: expected
  of the architect, checked by nothing.

## Git-anchor metadata contract

A node bead carries Worktrunk anchors in metadata so any session can find
where the work physically lives. The orchestrator creates the checkout with
`wt switch --create <branch> --base <base> --no-cd --format=json` and stores
the returned branch/path before spawning. Never infer the path from the user
template.

| When | Who | Stamp |
|---|---|---|
| Writer checkout prepared | orchestrator | `wt switch --create <branch>`, stamp Worktrunk var `bead=<bead-id>` on the branch (`wt config state vars set bead <bead-id> --branch <branch>`), stamp node `branch`, canonical `worktree`, `base_sha` |
| Tool-using reviewer prepared | orchestrator | stamp Worktrunk var `bead=<review-wisp-id>` on the review checkout's branch, stamp the review wisp with its own `branch` and canonical `worktree` |
| Tool-using advisor/researcher prepared | orchestrator | stamp Worktrunk var `bead=<node-id>` on the checkout's branch, stamp the escalation wisp or research node with its own `branch` and canonical `worktree` |
| Runtime waiting | orchestrator | send only `CLAIM {resource-id}` to the waiting runtime, as a separate message |
| Claim | claim-holder | read `metadata.worktree` off the claimed bead (the only authoritative source of where it works); cross-check `wt -C <path> step eval '{{ vars.bead }}' --format json` returns the same bead id -- mismatch means another actor owns the tree, stop and do not write |
| Report (after push) | architect | stamp `push=<pushed commit SHA>` (+ refresh `branch` if renamed) |
| Merge | shepherd | `bd update <bead> --metadata '{"pr":<n>,"merge_sha":"<sha>"}'` |

Add a `repo` key when work lands in a different repository than the run epic.
`--metadata` merges with existing keys, so stamps never clobber `node` or
`scope`. Branch, push, PR, and merge anchors survive checkout teardown.

`worktree` rules:

- Every claim-holder resource owns its own canonical `worktree`. Do not store
  reviewer or advisor paths on the work node.
- Stamp it as an absolute path. The SubagentStop hook matches the agent's `cwd`
  against that value.
- Clear the pointer only after the claim-holder releases its claim and the
  orchestrator reclaims the checkout.

Choosing between a label and a metadata key is a cardinality rule, not a style
preference. Both filter on `bd ready` and both compose with `--claim`, so
filterability does not distinguish them.

| Carrier | Cardinality | Carries |
|---|---|---|
| Label | multi-value. A bead holds every label added | multi-value routing: `role:`, `lang:`, `evidence:`, `push:`, `state:`, `kind:`, `agent:` |
| Metadata | single-value per key. `--metadata` merges per key on write, so stamps never clobber `node` or `scope` | single-value enforcement: `worktree`, `branch`, `scope`, `base_sha`, `actor`, `merge_sha`, `stage`, `origin` |

A bead can hold `role:coder` AND `role:reviewer` at once. A stage pipeline built
on labels accumulated `stage:implement` + `stage:review` + `stage:fix` and sat in
three queues simultaneously. Single-value keys therefore MUST be metadata:
`worktree` as a label would mean two confinement boundaries and a write guard
that cannot choose. Worktree resolution is also "own `metadata.worktree` else
inherit from parent", and that walk reads exactly one value per bead, so two
worktree labels make it ambiguous at every level.

Flag forms: `bd update --metadata` takes a JSON string or `@file.json`, and
`--set-metadata key=value` is the repeatable form. Labels use `--add-label`,
`--remove-label`, `--set-labels`.

## Ready front + scope disjointness

Beads does not know about file scopes. Ready therefore takes these steps:

```
bd ready --label orc-node --parent "$EPIC" --json     # dep-cleared front
scope-check.py --candidate <bead-id> --epic "$EPIC"   # exit 0 disjoint, 1 conflict
```

`scope-check.py` (bundled, stdlib-only) uses `bd list --json` to read the
candidate's `scope` and every `in_progress` node bead's `scope`, then applies a
conservative glob-overlap rule (prefix containment either direction, and bare
`**` conflicts with everything). Before `bd update --claim`, run it. On a
conflict, leave the node unclaimed and pick another.

## Events: audit records + comments

The acting agent records every material protocol verb (`blocked advice reported
review fix conflict approve merged dismiss ask` + `failed`/`note`) as two
writes, with identity from `BEADS_ACTOR=<actor>`:

```
bd audit record --actor <actor> --kind tool_call --tool-name orc.<verb> \
  --issue-id <bead> --exit-code 0                    # append-only .beads/interactions.jsonl
bd comment <bead> "<VERB> <node> field=… output_ref=<abs artifact path>"
```

- **Audit record** = machine-parsable, append-only trail. `--tool-name
  orc.{verb}` carries the verb. Failures use `--exit-code 1` + `--error`.
- **Comment** = human-readable payload (the message fields), citing artifact
  paths instead of inlining long text.
- **Artifacts**: full briefs/reports go to
  `<artifacts>/<node>-<verb>-<resource>-<n>.md`, where `<resource>` is the id of
  the claimed bead or wisp; the comment carries the absolute path. Every
  dimension reviewer of one node writes its REVIEW artifact at the same time,
  and the resource id is what keeps those filenames apart.
- State-carrying verbs additionally flip status/label per the mapping table;
  `bd set-state` emits its own event bead, so transitions are double-anchored.

## Shepherd primitives

- **Mutual exclusion:** `bd merge-slot create` once per run (idempotent), with
  a stable holder such as `run-<id>-shepherd`. Acquire without `--wait`.
  Contention is advisory, so report the current holder and retry after release.
  Always release, on success and conflict and CI wait and failure. On restart,
  `bd merge-slot check` and verify remote state before releasing a slot held by
  the same stable actor.
- **Async waits:** `bd gate create --type=gh:pr --blocks <bead> --await-id <pr#>`
  (PR merge) or `--type=gh:run --await-id <run-id>` (CI). `bd gate check`
  evaluates and closes resolved gates. A gated bead stays out of `bd ready`.
- `conflict-probe.sh` is the merge-safety probe primitive (`conflicts`,
  `pairwise`, `ci`).

## Read the run (scribe / resume / close-out)

| Question | Command |
|---|---|
| run status | `bd list --label orc-node --parent <epic> --all --json` (status + `state:` label + metadata) |
| one node's story | `bd show <bead> --json` + `bd comments <bead>` |
| audit trail | filter `.beads/interactions.jsonl` by `issue_id`/`actor` (append-only JSONL, read with jq or stdlib) |
| dep structure / impact | `bd dep tree <bead>`, `bd graph` |
| open waits | `bd gate list`, `bd merge-slot check` |
| resume after crash | in-flight = `bd list --label orc-node --parent <epic> --status in_progress --json`, agent handle = bead `assignee`, location = metadata `worktree`/`branch` |
| close-out gate | `bd dep cycles` clean AND `bd list --label orc-node --parent <epic> --status in_progress,blocked --json` empty (blocked = surfaced `failed` nodes) AND no stranded bead AND no undrainable merge bead |
| stranded beads | `comm -13 <(bd ready --label orc-node --parent <epic> --json \| jq -r '.[].id' \| sort) <(bd list --label orc-node --parent <epic> --status open,blocked --no-assignee --json \| jq -r '.[].id' \| sort)`, which lists beads that are unassigned but not ready. Then run `bd list --label orc-node --parent <epic> --status in_progress --json` and check each nonempty `assignee` against a live actor. |

A bead that is neither ready nor claimed counts as stranded. The store never
reports a dead actor, so the stranded query is the only signal. Two measured
cases, both of which pass the `in_progress,blocked` gate:

- A provider 403 killed two test shepherds before they wrote any claim or
  comment. Three merge beads stayed claimable after both actors died.
- A bounced bead keeps an owner who never returns.

Merge beads carry no `orc-node` label, so both queries above skip them. They
strand a third way. The bead is open and unassigned, yet missing an anchor the
cross-run queue matches on. Before close-out, run this query.

```bash
bd list --label-any pr:merge,agent:integrator --status open --json \
  | jq -r '.[] | select((.labels|index("pr:merge")|not)
      or (.labels|index("agent:integrator")|not)
      or ([.metadata.repo,.metadata.origin_actor,.metadata.branch]|any(.==null))) | .id'
```

Empty output passes the gate. Any id listed is drainable by nobody.
`pr-merge-bead-guard.py` requires all five anchors, and the queue that drains
between runs finds a bead only when every one is present. A run on bd 1.2.2 made
merge beads holding `agent:integrator` alone, so `bd list --label pr:merge`
returned nothing against beads that existed. Presence checks pass that run.

## SpecKit / external frameworks

A beads-managed SpecKit molecule (`bd swarm create <epic>`, `bd ready --mol`)
already IS a dependency-aware run DAG. When such a molecule drives the work,
use its step beads as the run's node beads. Never build a second graph on top.
Add the `orc-node` label + `scope` metadata to the step beads. Then
`scope-check.py`, the state mapping, and the anchor contract apply unchanged.
