---
name: beads-reconcile-from-receipts
description: "When reconciling landing receipts into Beads."
alwaysApply: true
---

# Receipt-driven reconciliation

MUST route every ledger write derived from a landing receipt through `bd_reconcile`. A landing tool never writes the ledger.

MUST read a numeric-v1 receipt with these exact fields: `schema: string`, `version: 1`, `emittedAt: ISO 8601 string`, `emitter: { plugin: string, version: string, tool: string }`, `repo: { key, canonicalRoot, remote, forge, nameWithOwner }`, `pr: { number, url, state, baseRefName, headRefName, headRefOid, mergeCommitOid, mergedAt }`, `branch: { name, deletedRemote: boolean, remoteAbsenceVerifiedAt: string | null, autoDeleteSetting: on | off | unknown }`, `worktree: { path: string | null, removed: boolean, localRefDeleted: boolean, absenceVerifiedAt: string | null }`, `beads: { ids: string[], ledgerActive: boolean }`, `proof: { method: string, observedAt: string, evidence: object }`, `outcome: landed | cleaned | partial`, `supersedes: string | null`, and optional `notes: string`. `repo.forge` is `github`, `gitlab`, or `unknown`. Do not invent `continues` or a string-valued `version` field.

MUST read one JSON receipt from `<agentDir>/receipts/<repoKey>/<receiptId>.json`. `agentDir` is `PI_CODING_AGENT_DIR` when set and `$HOME/.omp` otherwise. Create the directory recursively with mode `0700`; atomically rename a temporary file in the same directory. A receipt is never written inside a worktree. `repoKey` is the first 16 hexadecimal characters of the SHA-256 of the real path from `git rev-parse --git-common-dir`; the canonical checkout and every linked worktree share it. `receiptId` is `<epochMillis>-<first 12 characters of mergeCommitOid>` or `<epochMillis>-nomerge`.

MUST refuse a receipt whose schema differs or whose version is later than numeric version `1`, and state the observed version in the refusal. Do not guess a later version. A partial receipt, a cleaned receipt, or an unknown-cleanup receipt may still drive safe convergent anchor and audit repairs; none supplies close proof by itself.

MUST keep responsibilities separate. Delivery writes receipts and performs forge and git operations when that delivery tooling is available. Delivery never writes the Beads ledger. When delivery tooling is unavailable, record the missing handoff and continue with `bd_reconcile` only when it is available. `bd_reconcile` performs every ledger write derived from a receipt. A cleanup handoff must refuse while the ledger is unreconciled and name `bd_reconcile` in the refusal.

MUST use `bd_reconcile` with parameters `{ receipt?: string, bead?: string, repoKey?: string, apply?: boolean }`. `apply` defaults to `false`, which plans and writes nothing. Read-only `show` and `list` operations may decide a refusal. Apply writes only after exact proof and the convergent repair allowlist pass.

MUST require exact close proof before automatic close:
- an exact merged pull request;
- matching receipt `pr` metadata;
- no open gate;
- every child bead closed; and
- clean recorded state.
Partial, cleaned, and unknown-cleanup receipts provide repair evidence only. They cannot close a bead whose child is open or whose gate is unresolved.

MUST keep repairs convergent with this four-item allowlist: release a dead assignment or lease under CAS; set merge anchors only when absent or exactly equal; add a `discovered-from` edge only when the source identity is authoritative; add a merge audit event only when missing. Record semantic events with [rule://beads-audit]rule://beads-audit.

NEVER auto-reopen, auto-supersede, force-close, or prune. Report a conflicting field with its observed and expected values. Every refusal names the exact missing proof. Never overwrite a conflict, promote `unknown` to `true`, or infer absence from a successful mutation.

MUST close hierarchy leaves first. Reconcile and close a child before its parent. Stop at an open child, unresolved gate, conflicting field, missing proof, or ambiguous receipt. Add a concise ambiguity comment and create or use a human gate when a person must answer. Follow [rule://beads-lifecycle]rule://beads-lifecycle for status transitions and gates.

MUST orient before cleanup or hierarchy repair when the optional delivery orientation handoff is available. `ExtensionContext` carries no agent role identity, so orientation is model-callable and conditional. The main agent or lead remains an explicit prose orientation; when no merging agent is live, the current main agent is the fallback. No task may claim that role enforcement exists in code.

DEFAULT Record the receipt path, numeric schema version, and decisive proof in a bead comment or durable decision carrier before close. Follow [rule://beads-carriers]rule://beads-carriers for carrier authority.
