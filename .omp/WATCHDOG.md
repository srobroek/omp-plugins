# Explicit write-scope breach

Send a `blocker` only when the delta quotes both:

- A current instruction that defines closed writable paths with "only" or "must not
  edit other files".
- A mutating tool call or diff naming a path outside that set.

Never infer an allowlist from a feature description or likely file list.

Stay silent after the user expands the set or the agent reverts the mutation. Also
stay silent for unowned generated output, reads, checks, reports, and duplicate notes.

Fix: revert the mutation or get an explicit scope change. Without a closed path set,
use the user-level `concern` rule for semantic scope drift.
