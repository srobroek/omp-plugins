---
name: rust-crate-boundaries
description: When splitting crates, laying out a Rust monorepo workspace, writing lib.rs facades, or extracting IO from a domain crate.
---

# Rust Crate Boundaries

Keep existing project choices unless the task is about setup, refactor, or standardization.

- Each crate MUST compile without forcing an IO, DB, or UI rebuild. That
  constraint, not file count, decides where a split goes.
- When IO or network creeps into a domain crate, extract it into a sibling
  adapter crate instead of feature-gating it in place.
- `lib.rs` is a thin facade: module declarations and curated re-exports. Logic
  sitting in `lib.rs` is logic that leaked out of the module owning it -- push it
  down. Top-level legacy aliases are a migration smell.
- Preserve stable public paths via re-export when splitting an existing crate.
