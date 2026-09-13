---
name: beads-carriers
description: "Which carrier holds a decision and what makes it authoritative: comments, decision beads, wisps, artifacts."
---

# Beads carriers: comments, decision beads, wisps, artifacts

Choose the carrier that matches the scope and durability of the record. The
orchestration package maps its run model onto these carriers; it does not
redefine their authority.

| Carrier | Stores | Authority and lifecycle |
|---|---|---|
| Work-bead comment | A choice affecting one bead and its owned scope | Durable local source of truth; author is the actor. Accepted comments remain; provisional comments name an objective revisit trigger. |
| `decision` bead | A choice affecting multiple beads, agents, or packages | Durable cross-boundary source of truth with owner, stable key, design, acceptance, disposition, and non-blocking links. |
| Message wisp | A question, reply, notification, or acknowledgement | Ephemeral coordination only. Promote a material outcome before action or closure. |
| Artifact / `output_ref` | A brief, report, test log, or inspectable evidence payload | Evidence only. A comment or decision bead must cite it before it becomes part of a durable record. |

A material message changes a choice, default, scope, route, ordering,
acceptance evidence, disposition, or human answer. Classify it as bead-local or
cross-boundary, write the durable record and affected links, read that record
back, then act from it. Acknowledge or compact the wisp only after promotion
succeeds. No promotion means no policy action and no closure based on that
message. Restart recovery reads comments and decision beads before wisps or
artifacts.

For a local choice, set `BEADS_ACTOR` and record owner, scope, decision,
rationale, evidence, status, and (when provisional) an objective revisit trigger
in a comment. Read it back before acting. For a cross-boundary choice, load
`skill://adr` for decision-bead authoring and links. Orchestration-specific
lifecycle and recovery belong to `skill://orchestrate`.
