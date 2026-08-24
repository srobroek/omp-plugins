---
name: rust-safe-mutation
description: When implementing plan/approve/apply flows, TOCTOU CAS freshness, path traversal checks, or mutation audit trails in Rust.
globs: ["**/*.rs", "**/Cargo.toml"]
---

# Rust Safe Mutation

For side-effecting operations behind a plan/approve/apply flow:

- Approval is a token re-verified at apply time, not a boolean stored at review
  time. A stale token MUST error rather than proceed -- the gap between review and
  apply is where TOCTOU bugs live.
- Revalidate item freshness with a size plus mtime compare-and-swap at apply
  time; a changed item pauses the plan rather than applying to stale state.
- Normalize paths lexically and `lstat` each component. Do NOT use
  `canonicalize`: it resolves symlinks, which defeats the traversal check you are
  trying to perform. Reject symlink and junction traversal unless explicitly
  enabled per root.
- Write an audit record per attempted action AND its outcome (applied / refused /
  failed). The audit trail is append-only; the live progress stream is additive
  and never a substitute for it.
- Prefer trash or archive over permanent delete; permanent delete requires
  separate explicit consent.
