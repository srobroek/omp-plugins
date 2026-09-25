---
name: orchestrate-process
description: Governs pull-based orchestration, durable bead evidence, worktree isolation, review repair, and integration ownership.
---

# Orchestration Process

## Pull-based ownership

MUST dispatch all ready work for a role together.
MUST treat a phase boundary as continuation, not a stopping point.
MUST verify worker claims instead of trusting worker reports.
Before dispatching any worker, the lead MUST run the orchestrate preflight once for the run. Record its verdict in the governing run or epic bead metadata as `execution_preflight`, and record the immutable run base commit as `base_sha`. A preflight `FAIL` blocks dispatch, and so does a `skip` reporting that the beads or worktrunk companion is absent; other `warn` and `skip` results do not. At run start, the lead MUST claim one governing epic with `bd update EPIC --claim`, write its run and `base_sha` metadata, and read it back with `bd show EPIC --json`; it MUST stop if another live run holds that epic.


The main agent, lead, parent, and sub-lead MUST each explicitly instruct every pull-based worker to pull its role-routed claim pool. Use this instruction before work begins: `Pull your role-routed ready queue, claim each matching bead, execute it, record evidence, and continue pulling until no ready bead carries your pool alias.` After receiving that instruction, pull-based workers MUST continuously run this loop until the bounded pool wait returns a timeout or error:

1. Pull with the exact invocation `bd ready --assignee pool:ROLE --json`.
2. `bd ready` has no parent filter. Accept only records whose metadata `epic_id` exactly equals the epic id owned by that lead; ignore records for every other epic.
3. Claim a selected record atomically with `bd update ID --claim`. A lead raises priority and names a specific bead id as a direct cue; naming a bead is not direct assignment and the worker still claims it. The lease heartbeat resumes automatically when the agent wakes; before any further write, the worker MUST confirm the claim with `bd heartbeat ID`, which renews the lease and fails if the claim was lost. If it fails, or a heartbeat notice reports failure, it MUST stop writing to that bead.
4. Execute the bead, record durable evidence, hand implementation to the review pool or lead-owned integration queue as the role requires, and never force-close a work bead from a worker.
5. When a pull-based worker's pull returns no matching ready record, call the registered `pool_wait` tool with `{pool: "pool:ROLE", epic_id: "EPIC_ID"}`. The tool polls `bd ready --assignee POOL --json` in-process with no model turn, filters exact `metadata.epic_id`, and returns a ready record, a timeout, or a structured error. A ready result returns to step 1; only timeout or error ends this worker run.

Automatic heartbeat keeps a claim alive while its agent runs; a lease expires once the holder ends its run or dies. An expired lease NEVER proves death. The lead MUST NOT release a worker's bead unless that worker is absent or finished in `read proc://` AND its lease has expired; when both hold, it MUST use `bd update ID --assignee pool:ROLE --status open --if-assignee ACTOR`, then read back `open` assigned to the pool.
If `bd show` or a CAS reports another holder or a closed bead, the worker MUST stop writing to that bead and report it; it MUST NEVER retry under the new holder.
 
## Wait discipline

Subagent results and peer messages auto-deliver. A subagent lead (the orchestrator or any sub-lead) MUST spawn its workers, then YIELD; OMP parks the lead, and yielding is not completion. Each worker result or message wakes the parked lead into a new turn. While work remains open, the lead MUST handle what arrived and YIELD again.
A subagent lead MUST NOT stay active in its current turn or call `wait` for dispatched work. NEVER poll to discover completion. Useful work includes reviewing a returned result, updating the ledger, integrating a delivered branch, dispatching the next independent bead, and answering a peer.
Root only: the depth-0 session is the only agent with `wait`. The root MUST call `wait` only when completely blocked with no useful work left; results and messages arrive automatically. A headless root MUST NOT end its turn while dispatched work is outstanding.
Historical rationale only: in a graded arm, 55 of 89 lead waits returned nothing usable, including 29 waits on agents that had already finished.

Every worker brief MUST pass the lead's runtime id as `<leadId>`. Workers MUST report only with `write agent://<leadId>` and NEVER with `write agent://all`. A worker MAY confirm the id against the `Parent` shown by `read history://<own-id>`. OMP does not enforce this routing; the brief and worker MUST enforce it.
 

## Ledger contract

MUST use the Beads CLI as the ledger and keep the parent, epic, feature, task, dependency, ownership, evidence, and review state on beads rather than in prompts or wisps.
MUST express dependency meaning explicitly: `blocks` orders work; parent-child records hierarchy; `discovered-from` records a follow-up found during work; `related` and `tracks` are non-blocking.
MUST record research evidence on the research bead with `bd comment ID "FINDING"`. Separate direct observations from inferences and cite repository paths with line ranges or authoritative URLs.

Metadata families and timing:

| Family | Timing and required contents |
|---|---|
| `execution_*` | REQUIRED before spawn: run, parent, epic, and routing context needed to resume orchestration. |
| `repo`, `branch`, `base_sha`, `worktree`, `pr`, `merge_sha` | Git and delivery anchors; worker or integrator populates each as it becomes known. |

After the shepherd's delivery_land on an active ledger, the shepherd MUST close each receipt bead in children-first order with bd update ID --set-metadata pr=N --set-metadata merge_sha=SHA, then bd close ID --reason "PR #N merged as SHA; receipt PATH", and run delivery_cleanup. On a retired or ledger-free receipt, the shepherd MUST run delivery_cleanup directly after delivery_land; the lead MUST only verify the shepherd's result and MUST NOT duplicate these ledger writes. Delivery tools never write the Beads ledger.

Tier selection is a lead decision made at dispatch and recorded on the bead so an auditor can see which tier was chosen and why. Use the documented `execution_*` metadata family, specifically the exact key `execution_role`, with a value such as `implementer-high: root-cause diagnosis` or `implementer: local mechanical change`; do not invent another metadata key.
Conflict avoidance is a decomposition duty. The lead MUST decompose work into units that minimise overlap in files and functions. A conflict between concurrently dispatched workers is, by default, evidence that decomposition put two agents in the same place; it is not evidence of healthy integration. Some regions are shared by construction: identify any region that more than one unit of work would have to touch, typically shared contracts, schemas, generated artefacts, registries, or configuration that several features must extend. Name each shared region in the parent or epic bead, give it ONE owner bead that applies every dependent unit's required change, and make dependent units `blocks`-depend on it. This does NOT relax the existing conflict discipline.

1. Identify shared regions AT decomposition time and name them in the parent or epic bead.
2. Create ONE bead per shared region with ONE owner, which applies every epic's required change to that region.
3. Make dependent epics `blocks`-depend on that bead, so they wait rather than collide.
4. Before any dispatch, create and route AT MOST ONE DAG review bead to the existing `pool:work-reviewer` role. Its `--acceptance` criteria MUST cover exactly these areas:
   - dependency correctness, including missing `blocks` edges and cycles;
   - conflict risk, identified by repository inspection of beads that touch the same files or functions rather than by titles;
   - wasted or overstated parallelisation against the critical path;
   - decomposition and overlap, including correctly sized, non-overlapping beads and one owner bead for every shared region with dependents `blocks`-depending on it.
5. The single DAG review round MUST dispatch `work-reviewer` and the bundled `security-reviewer` in parallel for the same review. Both results together are that one round, not a second opinion. The lead records both verdicts on the governing bead before dispatching implementers into a contested region.
6. The review is time-boxed to a single round. The lead reads both verdicts, records on the governing bead what it accepted or changed, and then DISPATCHES; it does not commission another opinion. A second DAG review is a process violation; record it with the governing bead's durable evidence.
7. Dispatching implementers is the lead's primary duty and is never optional. If the review has not returned, or its verdict is unclear, the lead dispatches work known to be independent anyway and records that it did so. A clean verdict is not a precondition for independent work; it is a precondition only for starting work on a region the review flagged as contested.
8. Only independent work is dispatched concurrently. An arm that produces reviews and no implementation has failed, regardless of how good the plan is. A DAG dispatched without a recorded `execution_dag_review` is a process violation.


Only `execution_*` metadata is required before spawn. Keep every family on the governing bead as its values become known.

Every reviewable bead MUST have `--acceptance` criteria. Review and closure are incomplete until every criterion has durable evidence and a status of `met`, `unmet`, or `unverifiable: REASON`.

Create beads only with confirmed forms such as `bd create "title" -t task -p 2 --parent ID --assignee pool:ROLE --deps "discovered-from:ID" --metadata '{"epic_id":"EPIC_ID","execution_parent":"PARENT_ID"}' --description "SCOPE" --acceptance "CRITERIA"`. Every dispatchable bead MUST be assigned to its role's `pool:ROLE` alias before dispatch.

Independent review MUST precede every merge. A review failure MUST cause the work-reviewer to create exactly one fix bead for that round itself, carrying every actionable finding, with a `discovered-from` dependency to the reviewed bead, raised priority, the responsible pool alias, and return it to that role's pull queue. Preserve every finding and source bead. Create an implementer fix with `bd create "fix: SUMMARY" -t task -p 1 --parent EPIC_ID --assignee pool:implementer --deps "discovered-from:REVIEW_BEAD_ID" --metadata '{"epic_id":"EPIC_ID","execution_parent":"PARENT_ID","execution_role":"implementer"}' --description "ALL_FINDINGS_AND_SOURCE_IDS" --acceptance "REPAIR_CRITERIA"`; use `--assignee pool:implementer-high` for root-cause work. After two failed fix rounds on one bead, set it `blocked` with every finding and escalate to the lead; this cap applies to implementation review and PR bot-review rounds.

## Worktrees and integration

MUST provision exactly one linked worktree per worker. The lead records one run base commit in `base_sha`; the `--base` option takes a COMMIT and defaults to the default branch tip when omitted. Concurrent workers MUST pass the one run-recorded base commit and use that same `BASE_COMMIT` in exactly:

`wt switch -y --create --no-cd --base BASE_COMMIT --format json BRANCH`

Workers MUST take the worktree path from that command's JSON output. Provisioning runs in the Worktrunk post-start hook in the background; `rule://worktrunk-worktree-required` says what to do when a first test fails with missing modules. Use the documented branch naming convention `orc/EPIC_ID/AGENT_KIND/BEAD_ID`; this convention is not enforcement.
When a bead is released, its `worktree` metadata MUST remain. The next claimant adopts that tree only after checking `git status` and HEAD against the bead's `branch` metadata. A successor bead created because the approach was wrong after the fix-round cap MUST get a fresh worktree off the run base; the old tree remains until its own bead closes.

Worker-to-epic integration belongs to the epic orchestrator, never the shepherd. After a work-reviewer returns `APPROVED`, the orchestrator MUST freeze the exact approved worker head and run `git rev-parse HEAD` in the source worktree; it MUST equal that approved head before any merge. The orchestrator MUST then run `git merge-tree --write-tree EPIC_HEAD WORKER_HEAD` as a conflict preflight. A non-zero result, conflict, or unknown result is a hold: create exactly one fix bead back to the responsible implementer with the preflight evidence, leave the work bead open, and never hand-resolve the conflict. Only a clean preflight permits the orchestrator to run `wt merge EPIC_BRANCH --no-squash --no-ff` from the source worktree through Bash. If the merge-policy gate refuses the command, retry only with the same two explicit flags; NEVER retry with plain `wt merge`. Afterward verify that the source worktree still resolves to the approved head and the epic branch resolves to the merge SHA, then record `merge_sha` on the work bead with `bd update WORK_BEAD --set-metadata merge_sha=SHA` and close it with native `bd close WORK_BEAD --reason ...`.
After the last worker is integrated, the orchestrator MUST inspect `wt list --format json` and the epic branch's `merge_conflicts` for epic-to-default readiness. A true, non-zero, or unknown readiness result is a hold recorded by the orchestrator; it is not a shepherd worker-merge queue item.
After every worker is integrated and repository verification passes, the orchestrator determines whether an epic-to-default PR exists or is required. It spawns exactly one shepherd for that epic only for that final landing. The shepherd opens or refreshes the epic PR, verifies the exact reviewed head and bot approval, runs `gh pr checks`, calls `delivery_land`, performs native receipt-bead close-out, and calls `delivery_cleanup`. If no epic-to-default PR exists or is required, no shepherd is spawned. In a two-tier run each sub-epic orchestrator integrates its own workers into its sub-epic branch; the root lead then integrates each verified sub-epic branch into the root epic branch with the same exact-head check, merge-tree preflight, and `wt merge ROOT_EPIC_BRANCH --no-squash --no-ff` from the sub-epic worktree, and the root lead's one shepherd lands the root epic. A tier1 single-epic run still uses its shepherd for the epic PR.
 
## Review repair and conflicts

MUST create and route AT MOST ONE DAG review bead with the four DAG-plan acceptance criteria before dispatching; the single review round MUST dispatch `work-reviewer` and the bundled `security-reviewer` in parallel for the same review, record both verdicts and every accepted or changed finding on the governing bead, and dispatch implementers into a contested region only after both verdicts are recorded. A second DAG review is a process violation.
If an epic orchestrator's merge-tree preflight reports a conflict, it MUST create one implementer fix bead for that round and stop integration without resolving files. The implementer returns the repaired head to independent review; after approval the orchestrator repeats the exact-head check and preflight. A shepherd MUST NOT be asked to merge a worker into an epic, create a worker-merge queue item, or resolve that conflict.

## Durable coordination

MUST Use a wisp only when live step state need not synchronize to another clone, human, or agent.
Message wisps are limited to transient questions, replies, notifications, and acknowledgements. Durable decisions, acceptance evidence, review findings, and closure reasons belong in bead comments or another authoritative decision carrier; coordinate live handoffs with `write agent://AGENT_ID` and record the durable result with `bd comment`. Every worker uses the lead-id rule in Wait discipline and MUST NOT broadcast with `write agent://all`.

NOT let the lead implement product code; the implementer owns product changes, including conflict repairs. The lead owns orchestration, evidence verification, and worker-to-epic integration merges.
