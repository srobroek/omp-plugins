---
name: rust-domain-modeling
description: When defining Rust error enums, newtypes, or serde-transparent wrappers.
---

# Rust Domain Modeling

- Error scope: one `#[derive(thiserror::Error)]` enum per module scope, sized to
  the operation, with a `pub type XResult<T> = Result<T, XError>` alias per
  crate. Avoid a single god-error enum spanning the whole crate -- it forces every
  caller to match variants that cannot occur at their call site. Wrap foreign
  errors with `#[from]` only when the foreign type is stable.
- Newtype wrappers around IDs and validated values annotate
  `#[serde(transparent)]` so the wire format does not change when the wrapper is
  introduced.
