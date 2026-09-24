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


The main agent, lead, parent, and sub-lead MUST each explicitly instruct every worker to pull its role-routed ready queue. Use this instruction before work begins: `Pull your role-routed ready queue, claim each matching bead, execute it, record evidence, and continue pulling until no ready bead carries your role.` After receiving that instruction, workers MUST continuously run this loop until no ready bead carries their role:

1. Pull with the exact invocation `bd ready --label agent:KIND --unassigned --json`.
2. `bd ready` has no parent filter. Accept only records whose metadata `epic_id` exactly equals the epic id owned by that lead; ignore records for every other epic.
3. Claim a selected record atomically with `bd update ID --claim`. A lead raises priority and names a specific bead id as a direct cue; naming a bead is not direct assignment and the worker still claims it with this command. The lease heartbeat resumes automatically when the agent wakes; before any further write, the worker MUST confirm the claim with `bd heartbeat ID`, which renews the lease and fails if the claim was lost. If it fails, or a heartbeat notice reports failure, it MUST stop writing to that bead and report it.
4. Execute the bead, record durable evidence, then close it with `bd close ID --reason "EVIDENCE"`, or release it with `bd unclaim ID --if-assignee HOLDER --reason "..."` and read back its state; `--force` requires explicit user authorization.
5. Return to step 1 after every close or release. Stop only after the pull returns no ready record for the worker's `agent:KIND` label and matching `metadata.epic_id`.
Automatic heartbeat keeps a claim alive while its agent runs; a lease expires once the holder ends its run or dies. An expired lease NEVER proves death. The lead MUST NOT release a worker's bead unless that worker is absent or finished in `read proc://` AND its lease has expired; when both hold, it MUST use `bd unclaim ID --if-assignee HOLDER --reason "holder ended: EVIDENCE"`, then read back `open` and unassigned.
If `bd show` or a CAS reports another holder or a closed bead, the worker MUST stop writing to that bead and report it; it MUST NEVER retry under the new holder.
 
## Wait discipline

Subagent results and peer messages auto-deliver. The main agent, root lead, parent, sub-lead, and every epic orchestrator MUST NOT poll to discover that dispatched work finished.
Ending the turn is NOT a way to wait. These runs are headless: the process ends with the turn, and every dispatched agent is abandoned mid-flight. A lead ends its turn only when NO dispatched work is outstanding and its own work is complete.
While any dispatched agent is still running, the lead MUST remain in the turn. Call `wait` only when completely blocked with no useful work left; `wait` has no target filters and results or messages arrive automatically.
Useful work includes reviewing a returned result, updating the ledger, integrating a delivered branch, dispatching the next independent bead, and answering a peer. Prefer any of those over waiting.
Historical rationale only: in a graded arm, 55 of 89 lead waits returned nothing usable, including 29 waits on agents that had already finished.
A turn ended with dispatched work outstanding is a process violation, like other violations in this rule; record it with the governing bead's durable evidence.
Two consecutive waits with no intervening action are a polling loop; perform useful work before waiting again.
 

## Ledger contract

MUST use the Beads CLI as the ledger and keep the parent, epic, feature, task, dependency, ownership, evidence, and review state on beads rather than in prompts or wisps.
MUST express dependency meaning explicitly: `blocks` orders work; parent-child records hierarchy; `discovered-from` records a follow-up found during work; `related` and `tracks` are non-blocking.
MUST record research evidence on the research bead with `bd comment ID "FINDING"`. Separate direct observations from inferences and cite repository paths with line ranges or authoritative URLs.

Metadata families and timing:

| Family | Timing and required contents |
|---|---|
| `execution_*` | REQUIRED before spawn: run, parent, epic, and routing context needed to resume orchestration. |
| `repo`, `branch`, `base_sha`, `worktree`, `pr`, `merge_sha` | Git and delivery anchors; worker or integrator populates each as it becomes known. |

After `delivery_land` on an active ledger, the lead MUST call `bd_reconcile` with the returned receipt path BEFORE any ledger write about the delivered beads. It NEVER writes `merge_sha` or `pr` anchors or closes a delivered bead itself; `bd_reconcile` performs those writes. `delivery_cleanup` follows reconciliation.

Tier selection is a lead decision made at dispatch and recorded on the bead so an auditor can see which tier was chosen and why. Use the documented `execution_*` metadata family, specifically the exact key `execution_role`, with a value such as `implementer-high: root-cause diagnosis` or `implementer: local mechanical change`; do not invent another metadata key.
Conflict avoidance is a decomposition duty. The lead MUST decompose work into units that minimise overlap in files and functions. A conflict between concurrently dispatched workers is, by default, evidence that decomposition put two agents in the same place—not evidence of healthy integration. Some regions are shared by construction: identify any region that more than one unit of work would have to touch, typically shared contracts, schemas, generated artefacts, registries, or configuration that several features must extend. Name each shared region in the parent or epic bead, give it ONE owner bead that applies every dependent unit's required change, and make dependent units `blocks`-depend on it. This does NOT relax the existing conflict discipline: when a conflict occurs, the lead MUST resolve it by touching only its own content and report the resolution; the change prevents avoidable conflicts.

1. Identify shared regions AT decomposition time and name them in the parent or epic bead.
2. Create ONE bead per shared region with ONE owner, which applies every epic's required change to that region.
3. Make dependent epics `blocks`-depend on that bead, so they wait rather than collide.
4. Before any dispatch, create and route AT MOST ONE DAG review bead to the existing `agent:work-reviewer` role; its `--acceptance` criteria MUST cover exactly: dependency correctness, including missing `blocks` edges and cycles; conflict risk, identifying beads that touch the same files or functions by repository inspection rather than titles; wasted or overstated parallelisation against the critical path; and decomposition and overlap, including correctly sized, non-overlapping beads and one owner bead for every shared region with dependents `blocks`-depending on it.
5. The single DAG review round MUST dispatch `work-reviewer` and the bundled `security-reviewer` in parallel for the same review. Both results together are that one round, not a second opinion. The lead records both verdicts on the governing bead before dispatching implementers into a contested region.
6. The review is time-boxed to a single round. The lead reads both verdicts, records on the governing bead what it accepted or changed, and then DISPATCHES; it does not commission another opinion. A second DAG review is a process violation; record it with the governing bead's durable evidence.
7. Dispatching implementers is the lead's primary duty and is never optional. If the review has not returned, or its verdict is unclear, the lead dispatches work known to be independent anyway and records that it did so. A clean verdict is not a precondition for independent work; it is a precondition only for starting work on a region the review flagged as contested.
8. Only genuinely independent work is dispatched concurrently. An arm that produces reviews and no implementation has failed, regardless of how good the plan is. A DAG dispatched without a recorded `execution_dag_review` is a process violation.


Only `execution_*` metadata is required before spawn. Keep every family on the governing bead as its values become known.

Every reviewable bead MUST have `--acceptance` criteria. Review and closure are incomplete until every criterion has durable evidence and a status of `met`, `unmet`, or `unverifiable: REASON`.

Create beads only with confirmed forms such as `bd create "title" -t task -p 2 --parent ID --deps "discovered-from:ID" --metadata '{"epic_id":"EPIC_ID","execution_parent":"PARENT_ID"}' --description "SCOPE" --acceptance "CRITERIA"`. Every dispatchable bead MUST carry the routing label `agent:KIND` before dispatch; label assignment is a project convention, not an undocumented CLI invocation.

Independent review MUST precede every merge. A review failure MUST cause the work-reviewer to create exactly one fix bead for that round itself, carrying every actionable finding, with a `discovered-from` dependency to the reviewed bead, raised priority, the responsible `agent:KIND` routing label by project convention, and return it to that role's pull queue. Preserve every finding and source bead. Create it with the confirmed form `bd create "fix: SUMMARY" -t task -p 1 --parent EPIC_ID --deps "discovered-from:REVIEW_BEAD_ID" --metadata '{"epic_id":"EPIC_ID","execution_parent":"PARENT_ID","execution_role":"KIND"}' --description "ALL_FINDINGS_AND_SOURCE_IDS" --acceptance "REPAIR_CRITERIA"`. After two failed fix rounds on one bead, set it `blocked` with every finding and escalate to the lead; this cap applies to implementation review and PR bot-review rounds.

## Worktrees and integration

MUST provision exactly one linked worktree per worker. The lead records one run base commit in `base_sha`; the `--base` option takes a COMMIT and defaults to the default branch tip when omitted. Concurrent workers MUST pass the one run-recorded base commit and use that same `BASE_COMMIT` in exactly:

`wt switch -y --create --no-cd --base BASE_COMMIT --format json BRANCH`

Workers MUST take the worktree path from that command's JSON output and run `wt step copy-ignored` in the provisioned worktree before editing. Omitting `wt step copy-ignored` can make focused tests fail with missing-module errors that falsely look like broken code. Use the documented branch naming convention `orc/EPIC_ID/AGENT_KIND/BEAD_ID`; this convention is not enforcement.
When a bead is released, its `worktree` metadata MUST remain. The next claimant adopts that tree only after checking `git status` and HEAD against the bead's `branch` metadata. A successor bead created because the approach was wrong after the fix-round cap MUST get a fresh worktree off the run base; the old tree remains until its own bead closes.

Worker-to-epic integration MUST use `wt merge --no-squash --no-ff`, with both flags explicit on every such command. `wt` ignores a `[merge]` key in committed project `.config/wt.toml`; a configured `[commit.generation]` makes default `wt merge` squash everything into one generated commit. Omitting the flags at this level destroys the per-commit history and the conflict record. Epic-branch-to-default integration MAY use plain or squashing `wt merge` so main receives one clean commit per epic.
Before merger handoff, the lead MUST run worker-to-epic `git merge-tree --write-tree EPIC_HEAD WORKER_HEAD`, then epic-to-default `wt list --format json` and inspect that branch's `merge_conflicts`. A non-zero exit, `true`, or unknown result is a hold; the merger still refuses and the lead resolves it.

## Review repair and conflicts
MUST create and route AT MOST ONE DAG review bead with the four DAG-plan acceptance criteria before dispatching; the single review round MUST dispatch `work-reviewer` and the bundled `security-reviewer` in parallel for the same review, record both verdicts and every accepted or changed finding on the governing bead, and dispatch implementers into a contested region only after both verdicts are recorded. A second DAG review is a process violation.

If integration conflicts, the merger MUST report the conflict to the lead through `write agent://AGENT_ID` and stop without resolving it. ONLY the lead resolves an integration conflict; the merger never resolves conflicts, reviews its own work, or substitutes for independent review. The lead reruns verification after resolution.

## Durable coordination

MUST Use a wisp only when live step state need not synchronize to another clone, human, or agent.
Message wisps are limited to transient questions, replies, notifications, and acknowledgements. Durable decisions, acceptance evidence, review findings, and closure reasons belong in bead comments or another authoritative decision carrier; coordinate live handoffs with `write agent://AGENT_ID` or `write agent://all` and record the durable result with `bd comment`.

NOT let the lead implement product code; the implementer owns product changes. The lead owns orchestration, evidence verification, and integration-conflict resolution.
