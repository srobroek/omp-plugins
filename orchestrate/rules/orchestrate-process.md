---
name: orchestrate-process
description: Governs pull-based orchestration phases, lead verification, and integration ownership.
---

# Orchestration Process

| Situation | Choice |
|---|---|
| Ready beads share a role | Dispatch all ready work for that role together. |
| A phase reaches its planned boundary | Continue to the next phase; a boundary is not a stopping point. |
| A worker reports completion | Lead verifies the claim against the repository and acceptance criteria. |
| Product changes are needed | Assign implementation to the implementer; lead never implements product code. |
| An integration conflict remains after review | Lead resolves the integration conflict, then reruns verification. |

MUST dispatch all ready work of a role together.
MUST treat a phase boundary as continuation, not a stopping point.
MUST verify worker claims instead of trusting worker reports.
MUST keep product implementation with the implementer.
DEFAULT let the lead resolve integration conflicts only after the responsible work is complete.
NOT let the lead implement product code; the implementer does it.
