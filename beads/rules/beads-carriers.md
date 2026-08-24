---
name: beads-carriers
description: Which carrier holds a decision and what makes it authoritative: comments, decision beads, wisps, artifacts.
---

# Beads carriers: comments, decision beads, wisps, artifacts

Which carrier holds a choice, and what makes it authoritative. This applies to any beads work; the
orchestration package maps its own run model onto these carriers rather than redefining them.

## Coordination and policy carriers

| Carrier | Stores | Authority and lifecycle |
|---|---|---|
| Work-bead comment | A choice that affects only that bead and its owned scope | Durable local source of truth. The comment author is the actor. Accepted comments remain; provisional comments name an objective revisit trigger. |
| `decision` bead | A choice that affects more than one bead, agent, or package, or constrains later work | Durable cross-boundary source of truth. It carries an owner, stable key, design, acceptance/verification, status/disposition, and non-blocking links to every affected bead. |
| Message wisp | A question, reply, notification, acknowledgement, or other live coordination | Ephemeral coordination only. A material outcome is promoted to a comment or decision bead before action or closure. Acknowledgement or compaction never deletes the promoted source of truth. |
| Artifact / `output_ref` | A large brief, report, test log, or other inspectable evidence payload | Evidence only. It becomes part of a decision or report when a comment or decision bead cites its absolute path. The file alone is not policy or lifecycle state. |

A material message changes a choice, default, scope, route, ordering,
acceptance evidence, disposition, or human answer. Handle it in this order:

1. Classify its effect as bead-local or cross-boundary.
2. Write the local comment or decision bead and any affected-bead links.
3. Read the durable record back. A decision is effective only after every
   affected link is visible and non-blocking.
4. Act from that record and cite it in later comments or reports.
5. Acknowledge or compact the message only after promotion succeeds.

No promotion means no policy action and no closure based on that message.
Restart recovery reads comments and decision beads before message wisps or
artifacts.

## Local decision comments

Set `BEADS_ACTOR` to the choosing actor. Add the following record to the work
bead, then read it back with `bd comments <bead> --json` before acting:

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
`provisional` requires a nonempty event, dependency transition, exact evidence
change, or RFC3339 deadline. `later`, `if needed`, and elapsed time without an
observable condition are not triggers. Record the operation as `orc.note` in
the audit trail.

A readable comment is the local source of truth. If the audit write fails
after the comment succeeds, retry the audit before closing; do not duplicate
the comment. If the comment write or read-back fails, do not apply the choice.

## Cross-boundary decision beads

Create a first-class decision under the run epic before the choice affects a
second bead, agent, package, shared contract, ordering rule, or later work:

```text
type: decision
decision_key: <stable run-unique policy key>
decision_owner: <one accountable actor>
description: <choice and affected scope>
design: <rationale, known evidence, unknowns, bounds, and alternatives>
acceptance: <objective verification or acceptance evidence>
decision_disposition: <proposed|accepted|rejected|superseded|duplicate|conflict>
status: <open|in_progress|closed>
```

Use `relates-to` for affected work and `validates` for work that supplies or
checks acceptance evidence:

```text
bd dep add <affected-bead> <decision-bead> --type relates-to
bd dep add <validator-bead> <decision-bead> --type validates
```

Both edge types are non-blocking. Never use `blocks` for accepted policy or to
attach an already-running/closed affected bead. Ordering work still uses a
separate task dependency. An accepted, rejected, duplicate, or superseded
decision is closed with a disposition-specific reason; closed means resolved,
not erased.

Before creation, after restart, and before action, list every decision under the
epic with `bd list --type decision --parent <epic> --all --json`. Decisions
compete only when their nonempty `decision_key` values match.

Resolve each competing key deterministically:

1. Read every candidate and its `supersedes` edges. Reject an edge that crosses
   a `decision_key`, targets a missing bead, or creates a cycle.
2. When accepted candidates contain a valid explicit `supersedes` chain,
   canonical is the newest accepted unsuperseded head by `created_at`, then
   bead ID. Every older candidate in that key becomes `superseded`.
3. When no explicit supersession exists, canonical is the earliest candidate
   by `created_at`, then bead ID. Every other candidate becomes `duplicate`.
4. Read canonical again. Its `decision_disposition` must be `accepted`. Never
   update canonical while marking noncanonical beads.

Persist every noncanonical disposition as a resumable transaction. Read before
each command and skip a step whose exact result already exists:

```text
# Mark the noncanonical bead first.
bd update <noncanonical> \
  --set-metadata decision_disposition=<duplicate|superseded> \
  --set-metadata canonical_decision=<canonical>

# Duplicate: loser points to canonical without blocking it.
bd dep add <loser> <canonical> --type relates-to
bd close <loser> --reason "duplicate of <canonical>"

# Superseded: canonical explicitly supersedes the older decision.
bd dep add <canonical> <older> --type supersedes
bd close <older> --reason "superseded by <canonical>"
```

After every write, read both beads back. A noncanonical bead is resolved only
when its metadata, required edge, closed status, and close reason all match,
and canonical still has `decision_disposition=accepted`. If metadata, edge, or
close writes stop partway, record the failure and leave the observed partial
state. Restart repeats the same keyed reads, completes only missing steps, and
produces the same result without changing canonical.

`bd close` does not replace the close reason of an already-closed bead. When a
loser is closed with any reason other than the canonical duplicate or
superseded reason, repair it only after the loser metadata and required edge
have passed read-back:

```text
bd label add <loser> decision-repair
bd label add <loser> non-work
bd reopen <loser> --reason "repair stale decision close reason"
bd close <loser> --reason "<duplicate of|superseded by> <canonical>"
```

- Add both labels before reopening. Generic ready and claim selectors exclude
  `non-work`.
- Read back both labels and confirm canonical is still accepted. Run reopen and
  close consecutively.
- A restart between those commands recognizes `decision-repair` plus
  `non-work`, verifies the durable loser metadata and edge, skips reopen, and
  closes the loser with the canonical reason.
- Success requires a final read of both beads showing `status=closed`, the
  canonical close reason, the expected loser disposition and
  `canonical_decision`, and unchanged canonical metadata.

An invalid explicit chain remains `decision_disposition=conflict`; no candidate
is applied until the owner repairs the chain from evidence or enters
`waiting_human`. Never infer resolution from a message or artifact.
