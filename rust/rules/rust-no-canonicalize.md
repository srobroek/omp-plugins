---
name: rust-no-canonicalize
description: canonicalize resolves symlinks, which defeats the containment check it is usually reached for; normalize lexically instead.
scope: "tool:edit(*.rs), tool:write(*.rs)"
interruptMode: never
astCondition:
  - "canonicalize($$$ARGS)"
  - "$$$MOD::canonicalize($$$ARGS)"
  - "$RECV.canonicalize()"
---
`canonicalize` follows every symlink and junction on the way. A path that
lexically sits under an allowed root can therefore canonicalize to somewhere
else entirely, and the containment check passes on the resolved path while the
open happens through the link. That is the traversal escape the check exists to
stop.

Normalize lexically instead: split the path, drop `.`, pop on `..` without
touching the filesystem, refuse to pop above the root. Then `lstat` each
component and reject a symlink or junction unless that root explicitly enables
them.

`canonicalize` stays correct where symlink resolution is the point and no
boundary is being enforced -- printing a real path for a human, or deduplicating
two spellings of the same file. It is not a security primitive.

Rest of the mutation contract, including the apply-time freshness CAS:
`rule://rust-safe-mutation`.
