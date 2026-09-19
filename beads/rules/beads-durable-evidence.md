---
name: beads-durable-evidence
description: Keep decisive bead evidence in durable carriers that survive the writing session.
---

# Durable Bead Evidence

Inline the decisive substance in the bead text whenever a bead cites evidence. A
citation can accompany that substance; never make the citation the only carrier.

Never cite any of these as sole evidence:

- a `local://` artifact;
- an `agent://` handle; or
- a bare session id.

Use a durable carrier for evidence that must survive the writing session: a bead
comment, a commit message, or a tracked file. Name the carrier in the bead and
put the decisive content in the bead text when the acceptance depends on it.

Treat an acceptance criterion that consumes a citation as unperformable once its
carrier expires. For example, a bead that says “reconcile X against artifact Y”
must carry Y’s decisive content, or state the reconciliation against evidence
that still exists.

When a bead already cites a dead carrier, do not silently close it and do not
guess the missing content. Record that the carrier is gone. Then either rewrite
the acceptance against surviving evidence or close the bead as unrecoverable,
saying which disposition you chose.

Three beads were closed today as unworkable rather than done after their cited
carriers disappeared. A live Slopvac contract is also governed by an abbreviated
summary because its authoritative text lived in a session-scoped artifact. Keep
the authoritative evidence durable so this failure does not recur.
