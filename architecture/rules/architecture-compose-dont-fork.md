---
name: architecture-compose-dont-fork
description: When extending a subsystem, adding a new case or variant, or editing a generic core.
---

DEFAULT Make the simplest change to the existing core that satisfies the requirement.
MUST Compose through an existing extension boundary when the new behavior is an
independent variant and that boundary fits; add a boundary only for a concrete
consumer whose behavior requires separation.
NOT Add wrappers, files, or indirection merely to minimize the shared-core diff.
MUST Fork only when the paths have diverged in intent and sharing would couple
independent behavior; state the divergence and remove the obsolete shared seam.
