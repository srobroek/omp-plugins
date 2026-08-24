---
name: architecture-compose-dont-fork
description: When extending a subsystem, adding a new case or variant, or editing a generic core.
---

Add new behavior or a new case (provider/strategy/backend) by composing on top of
the generic core, not by editing it.

Make it verifiable: the strongest form is a near-empty diff to the shared
surface -- the change adds files and an additive extension point, touching the
generic core by close to zero lines.

Fork (copy + diverge) when the two paths have genuinely diverged in intent and
a shared abstraction would only couple them -- say so explicitly, and don't leave
a half-shared seam that must be re-audited on every change.
