---
name: beads-reconcile-from-receipts
description: "When reconciling landing receipts into Beads."
alwaysApply: true
---

# Receipt-driven reconciliation

MUST route every ledger write derived from a landing receipt through `bd_reconcile`. A landing tool never writes the ledger.

MUST read a numeric-v1 receipt whose documented keys carry exactly these concrete types:
- `schema`: the literal string `"omp.receipt.landing"`.
- `version`: the number `1`.
- `receiptId`: string.
- `emittedAt`: string holding an ISO 8601 instant.
- `emitter`: `{ plugin: string, version: string, tool: string }`.
- `repo`: `{ key: string of 16 lowercase hexadecimal characters, canonicalRoot: string, remote: string, forge: "github" | "gitlab" | "unknown", nameWithOwner: string }`.
- `pr`: `{ number: positive integer, url: string, state: string, baseRefName: string, headRefName: string, headRefOid: string, mergeCommitOid: string | null, mergedAt: string | null }`.
- `branch`: `{ name: string, deletedRemote: boolean, remoteAbsenceVerifiedAt: string | null, autoDeleteSetting: "on" | "off" | "unknown" }`.
- `worktree`: `{ path: string | null, removed: boolean, localRefDeleted: boolean, absenceVerifiedAt: string | null }`.
- `beads`: `{ ids: string[] of bead ids, ledgerActive: boolean }`.
- `proof`: `{ method: string, observedAt: string, evidence: object }`.
- `outcome`: `"landed"`, `"cleaned"`, or `"partial"`.
- `supersedes`: string naming the receipt this one continues, or `null`.
- `notes`: the one optional key, a string. A `notes` object is not v1. Refuse it and state the observed type.
Do not invent `continues` or a string-valued `version` field.

MUST treat every unknown top-level key as extension data:
- Its presence is not a refusal, and its content is never proof.
- Validate the documented keys above. A consumer that retains or re-emits the receipt object carries the unknown keys with it.
- A writer that re-emits receipt data copies each unknown top-level key verbatim into its continuation receipt. That continuation names the receipt it continues in `supersedes`.
- `bd_reconcile` writes the ledger and emits no receipt, so it re-emits nothing.
- Extension data never hides inside a documented v1 key.

MUST read one JSON receipt FILE that a delivery tool wrote at `<agentDir>/receipts/<repoKey>/<receiptId>.json`. `agentDir` is `PI_CODING_AGENT_DIR` when it is set to a non-blank value and `$HOME/.omp` otherwise; a whitespace-only value is unset on both sides of the contract. Create the directory recursively with mode `0700`; atomically rename a temporary file in the same directory. A receipt is never written inside a worktree. `repoKey` is the first 16 lowercase hexadecimal characters of the SHA-256 of the real path from `git rev-parse --git-common-dir`; the canonical checkout and every linked worktree share it. `receiptId` is `<epochMillis>-<first 12 characters of mergeCommitOid>` or `<epochMillis>-nomerge`, and it must equal the receipt's own filename.

MUST name that file by receipt id or path. No caller passes inline receipt JSON; a caller-supplied object or JSON string is refused naming the canonical path, because a receipt no delivery tool wrote is not evidence of a landing. The reader opens each receipt without following symlinks, refuses anything that is not a regular file, caps one receipt at 256 KiB, and bounds one directory scan, refusing past the cap rather than reconciling a subset.

MUST refuse a receipt whose schema differs or whose version is later than numeric version `1`, and state the observed version in the refusal. Do not guess a later version. A partial receipt, a cleaned receipt, or an unknown-cleanup receipt may still drive safe convergent anchor and audit repairs; none supplies close proof by itself.

MUST keep responsibilities separate. Delivery writes receipts and performs forge and git operations when that delivery tooling is available. Delivery never writes the Beads ledger. When delivery tooling is unavailable, record the missing handoff and continue with `bd_reconcile` only when it is available. `bd_reconcile` performs every ledger write derived from a receipt.

MUST follow the conditional lifecycle order: `delivery_land`, then `bd_reconcile`, then `delivery_cleanup` WHEN the ledger classification recomputed at the canonical root is active. A retired or ledger-free repository goes `delivery_land` then `delivery_cleanup` directly. Reconciliation therefore runs before cleanup and never requires the branch or worktree to be gone already; a cleanup handoff refuses while an active ledger stays unreconciled and names `bd_reconcile` in the refusal.

MUST use `bd_reconcile` with parameters `{ receipt?: string, bead?: string, repoKey?: string, apply?: boolean }`. No caller passes `cwd`: the tool declares none and reads the session working directory. `apply` defaults to `false`, which plans and writes nothing. Read-only `show` and `list` operations may decide a refusal. Apply writes only after exact proof and the convergent repair allowlist pass.

MUST require exact close proof before automatic close:
- a merged pull request the receipt names and a provider CLI observed, re-observed at reconcile time;
- an active ledger and no conflicting `pr`, `merge_sha`, `base`, `branch`, or `head_sha` anchor;
- no live assignment or lease;
- no open gate and no live blocker; and
- every child bead closed.
A receipt's own cleanup flags and a live absence verdict are never close proof; they only contradict a receipt that claims a cleanup which did not happen. Partial, cleaned, and unobserved (`proof.method` `unknown`) receipts provide repair evidence only.

MUST keep repairs convergent with this four-item allowlist: release a dead assignment or lease under CAS; set the `pr`, `merge_sha`, `base`, `branch`, and `head_sha` anchors only when absent, and report any present value that differs instead of overwriting it; add a `discovered-from` edge only when the source identity is authoritative; add a merge audit event only when missing. Record semantic events with [rule://beads-audit]rule://beads-audit.

NEVER auto-reopen, auto-supersede, force-close, or prune. Report a conflicting field with its observed and expected values. Every refusal names the exact missing proof. Never overwrite a conflict, promote `unknown` to `true`, or infer absence from a successful mutation.

MUST close hierarchy leaves first. Reconcile and close a child before its parent. Stop at an open child, unresolved gate, conflicting field, missing proof, or ambiguous receipt. Add a concise ambiguity comment and create or use a human gate when a person must answer. Follow [rule://beads-lifecycle]rule://beads-lifecycle for status transitions and gates.

MUST orient before cleanup or hierarchy repair when the optional delivery orientation handoff is available. `ExtensionContext` carries no agent role identity, so orientation is model-callable and conditional. The main agent or lead remains an explicit prose orientation; when no merging agent is live, the current main agent is the fallback. No task may claim that role enforcement exists in code.

DEFAULT Record the receipt path, numeric schema version, and decisive proof in a bead comment or durable decision carrier before close. Follow [rule://beads-carriers]rule://beads-carriers for carrier authority.
