---
name: beads-reconcile-from-receipts
description: "When reconciling landing receipts into Beads."
alwaysApply: true
---

# Receipt-driven Beads reconciliation

MUST route every ledger write derived from a landing receipt through `bd_reconcile`. A landing tool never writes the ledger.

MUST read one JSON receipt from `<agentDir>/receipts/<repoKey>/<receiptId>.json`. `agentDir` is `PI_CODING_AGENT_DIR` when set and `$HOME/.omp` otherwise. The directory is created recursively with mode `0700`; the writer atomically renames a temporary file in that same directory. A receipt is never written inside a worktree. `repoKey` is the first 16 hexadecimal characters of the SHA-256 of the real path from `git rev-parse --git-common-dir`; the canonical checkout and every linked worktree share it. `receiptId` is `<epochMillis>-<first 12 characters of mergeCommitOid>` or `<epochMillis>-nomerge` when there is no merge commit.

A version 1 receipt has these keys: `schema: string`, `version: string`, `emittedAt: ISO 8601 string`, `emitter: { plugin: string, version: string, tool: string }`, `repo: { key, canonicalRoot, remote, forge, nameWithOwner }`, `forge: github | gitlab | unknown`, `pr: { number, url, state, baseRefName, headRefName, headRefOid, mergeCommitOid, mergedAt }`, `branch: { name, deletedRemote: boolean, remoteObservedRefAt: string | null, autoDeleteSetting: on | off | unknown }`, `worktree: { path: string | null, removed: boolean, localRefDeleted: boolean, absenceVerifiedAt: string | null }`, `beads: { ids: string[], ledgerActive: boolean }`, `evidence: { method: string, evidence: object }`, `outcome: landed | partial`, `supersedes: string | null`, `receiptId: string`, `continues: string | null`, and optional `notes: string`. Unknown keys are preserved and never dropped from a continuation receipt.

MUST ignore an object whose schema differs. MUST refuse a version greater than the implementation version and state the observed version in the refusal. MUST preserve unknown keys when writing a continuation receipt and never guess a newer version. A consumer tolerates an unknown version unless the ledger fields themselves can be read. The same receipt object returned by the tool is `details.receipt`.

MUST keep responsibilities separate: delivery writes receipts and performs forge and git operations; delivery never writes the Beads ledger. `bd_reconcile` performs every ledger write derived from a receipt. `delivery_cleanup` refuses while the ledger is unreconciled and names `bd_reconcile` in the refusal; it never writes the ledger.

MUST classify tool names in the Worktrunk gate without changing either package's behavior. The final gate gives `READ_ONLY_TOOLS` the `delivery_orient` and `delivery_hygiene_report` tools. It gives `LEDGER_TOOLS` the `bd_reconcile` tool. The gate classifies mutability, and these tools run inside a linked worktree.

MUST keep the `delivery/package.json` `omp.extensions` manifest order as `./extensions/unpushed-work-advisory.ts`, `./extensions/delivery-land-tool.ts`, `./extensions/delivery-cleanup-tool.ts`, and `./extensions/hygiene-orientation.ts`. `landing-receipt.ts` and `forge-adapter.ts` are library modules imported by the tools and are never manifest entries. MUST keep `./dist/bd-reconcile-tool.js` as the final `omp.extensions` entry in `beads/package.json`; `python3 scripts/build-extensions.py` produces the committed bundle and `python3 scripts/build-extensions.py --check` verifies it.

MUST use the fixed tool ownership and approval: `delivery_land` owns `delivery/extensions/delivery-land-tool.ts` and requires execution approval; `delivery_cleanup` owns `delivery/extensions/delivery-cleanup-tool.ts` and requires execution approval; `delivery_orient` and `delivery_hygiene_report` own `delivery/extensions/hygiene-orientation.ts` and require read approval; `bd_reconcile` owns `beads/extensions/bd-reconcile-tool.ts` and bundled `beads/dist/bd-reconcile-tool.js`, requiring read approval when `apply` is absent or false and execution approval when `apply` is true.

MUST use `bd_reconcile` with parameters `{ receipt?: string, bead?: string, repoKey?: string, apply?: boolean }`. `apply` defaults to `false`, which plans and writes nothing. The tool may run read-only `show` and `list` operations to decide a refusal. The tool writes only when `apply: true` and the exact proof and convergent repair allowlist pass.

MUST treat a receipt as evidence, not authority. The receipt must prove an exact merged pull request. Receipt `pr` metadata must match the observed pull request. No gate may remain open. Every child bead must be closed. The bead must have a clean recorded state before automatic closure. A receipt never closes a bead whose children are open or whose gates are unresolved.

MUST keep repairs convergent: release a dead assignment or lease only under CAS; set merge anchors only when absent or exactly equal; add a `discovered-from` edge only when the source identity is authoritative; and add a merge audit event only when it is missing. Use the semantic-event form in [rule://beads-audit]rule://beads-audit.

NEVER auto-reopen, auto-supersede, force-close, or prune. Every refusal names the exact missing proof, field, observed value, and expected value. Report conflicting values and never overwrite them. `unknown` is never promoted to `true`, and absence is never inferred from a successful mutation.

MUST invoke `delivery_orient` before cleanup or hierarchy repair. Verified constraint: do not spend time working around it. `ExtensionContext` in `node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/types.ts` (lines 466-559) carries no agent role identity; an extension cannot tell the main agent, lead, or worker apart, so orientation is explicit and model-callable. The main agent or lead is named only in tool descriptions and steering prose; when no merging agent is live, the current main agent is the fallback owner. No shipped code or prose may claim that a main-agent-only or lead-only restriction is enforced in code.

MUST reconcile before cleanup and close hierarchy leaves first. Reconcile and close a child before its parent. Stop at an open child, unresolved gate, conflicting field, missing proof, or ambiguous receipt. Add a concise comment naming the ambiguity and create or use a human gate when a person must answer or dispose of the issue. Follow [rule://beads-lifecycle]rule://beads-lifecycle for status transitions and gates.

DEFAULT Record the receipt path, schema, version, and decisive evidence in a bead comment or durable decision carrier before closure. Follow [rule://beads-carriers]rule://beads-carriers for carrier authority and [rule://beads-audit]rule://beads-audit for semantic events.
