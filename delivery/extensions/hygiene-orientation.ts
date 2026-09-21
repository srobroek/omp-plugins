import type { Dirent, Stats } from "node:fs";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { readReceipt, receiptDirectory, repoKey } from "./landing-receipt";

/**
 * Read-only orientation over one repository's hygiene.
 *
 * Every question this module answers is answered from a Git primitive whose exit
 * code distinguishes "no" from "could not tell". Nothing here mutates, and no
 * absence of evidence is reported as evidence of cleanliness: the only three
 * verdicts are `actionable` (something is provably outstanding), `ambiguous`
 * (something could not be proved either way) and `clean`.
 */

type RunResult = {
	exitCode: number;
	signalCode: string | number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

export type HygieneStatus = "actionable" | "ambiguous" | "clean";

export type HygieneFinding = { kind: string; status: HygieneStatus; description: string; paths?: string[] };

/** How much a branch's publication state could be proved. */
export type TrackingKind = "tracked" | "no-upstream" | "detached" | "unmeasured" | "unavailable";

/**
 * One linked worktree of the repository, current or not.
 *
 * Every tree Git owns appears here, not only the ones sharing the current
 * branch: a sibling tree on another branch still holds work, and omitting it
 * makes the inventory look empty when it is not.
 */
export type WorktreeState = {
	path: string;
	current: boolean;
	branch: string | null;
	bare: boolean;
	tracking: TrackingKind;
	upstream: string | null;
	/** Commits on the branch and not on its upstream; null unless `tracking` is `tracked`. */
	ahead: number | null;
	/** Commits on the upstream and not on the branch; null unless `tracking` is `tracked`. */
	behind: number | null;
};

export type HygieneReport = {
	scope: { cwd: string; commonGitDir: string | null; currentWorktree: string | null };
	worktrees: WorktreeState[];
	status: HygieneStatus;
	findings: HygieneFinding[];
	limitations: string[];
	mutation: "none";
};

/** Bound on one child process. A scan runs at an interactive boundary. */
const TIMEOUT_MS = 2000;

/**
 * Bound on the whole scan. A repository with many worktrees would otherwise cost
 * one unbounded divergence count per tree; past the budget the remaining trees
 * are reported as unprovable rather than measured.
 */
const SCAN_BUDGET_MS = 10_000;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKTREES = 64;
const MAX_RECEIPTS = 256;
const MAX_RECEIPT_BYTES = 1024 * 1024;

function run(argv: string[], cwd: string, deadline: number): RunResult {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return { exitCode: 124, signalCode: null, stdout: "", stderr: "scan budget exhausted", timedOut: true };
	try {
		const p = Bun.spawnSync(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: Math.min(TIMEOUT_MS, remaining),
			killSignal: 9,
			maxBuffer: MAX_OUTPUT_BYTES,
		});
		// Bun reports a killed-on-timeout child through a field its published type omits.
		const timedOut = "exitedDueToTimeout" in p && p.exitedDueToTimeout === true;
		return {
			exitCode: p.exitCode,
			signalCode: p.signalCode ?? null,
			stdout: p.stdout.toString(),
			stderr: p.stderr.toString(),
			timedOut,
		};
	} catch (error) {
		return { exitCode: 127, signalCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
	}
}

function git(cwd: string, args: string[], deadline: number): RunResult {
	return run(["git", "--no-optional-locks", ...args], cwd, deadline);
}

/** A command not run at all: indistinguishable from one that failed, and treated so. */
const NOT_RUN: RunResult = { exitCode: 1, signalCode: null, stdout: "", stderr: "", timedOut: false };

function available(result: RunResult): boolean {
	return result.exitCode === 0 && !result.timedOut && (result.signalCode === null || result.signalCode === 0);
}

function realOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export type WorktreeEntry = { path: string; branch: string | null; detached: boolean; bare: boolean };

/** Every record of `git worktree list --porcelain`, including detached and bare trees. */
export function parseWorktrees(text: string): WorktreeEntry[] {
	const rows: WorktreeEntry[] = [];
	let row: WorktreeEntry | undefined;
	for (const line of text.split("\n")) {
		if (line === "") {
			if (row) rows.push(row);
			row = undefined;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (row) rows.push(row);
			row = { path: line.slice(9), branch: null, detached: false, bare: false };
			continue;
		}
		if (!row) continue;
		if (line.startsWith("branch ")) row.branch = line.slice(7).replace(/^refs\/heads\//, "");
		else if (line === "detached") row.detached = true;
		else if (line === "bare") row.bare = true;
	}
	if (row) rows.push(row);
	return rows;
}

export function parsePorcelainPaths(text: string): string[] {
	const fields = text.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < fields.length; i += 1) {
		const field = fields[i];
		if (!field || field.startsWith("## ")) continue;
		const code = field.slice(0, 2);
		const path = field.slice(3);
		if (path) paths.push(path);
		if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
			const original = fields[i + 1];
			if (original) {
				paths.push(original);
				i += 1;
			}
		}
	}
	return paths;
}

type UpstreamRow = { ref: string; short: string };

/**
 * Each local branch's configured upstream, read from `for-each-ref`.
 *
 * `for-each-ref` succeeds whether or not an upstream exists and prints an empty
 * field when there is none, so "no upstream" and "could not ask Git" stay
 * distinct. Parsing `git branch -vv` cannot make that distinction: it exits zero
 * either way and its one-line-per-branch text is also where `[ahead 1, behind 2]`
 * hides a `behind` count behind an `ahead` one.
 *
 * Null means Git could not be asked at all.
 */
function upstreamRefs(cwd: string, deadline: number): Map<string, UpstreamRow> | null {
	const result = git(cwd, ["for-each-ref", "--format=%(refname)%09%(upstream)%09%(upstream:short)", "refs/heads/"], deadline);
	if (!available(result)) return null;
	const map = new Map<string, UpstreamRow>();
	for (const line of result.stdout.split("\n")) {
		if (line === "") continue;
		const [refname, ref, short] = line.split("\t");
		if (!refname) continue;
		map.set(refname, { ref: ref ?? "", short: short ?? "" });
	}
	return map;
}

/**
 * Exact commit counts on both sides of the branch/upstream symmetric difference.
 *
 * `--left-right --count` prints the two counts as separate fields, so a diverged
 * branch reports its `ahead` and its `behind` rather than whichever one a text
 * format happened to put first. Null means the count could not be taken — an
 * upstream ref that is gone, for instance.
 */
function divergence(cwd: string, branchRef: string, upstreamRef: string, deadline: number): { ahead: number; behind: number } | null {
	const result = git(cwd, ["rev-list", "--left-right", "--count", `${branchRef}...${upstreamRef}`], deadline);
	if (!available(result)) return null;
	const [left, right] = result.stdout.trim().split(/\s+/);
	if (left === undefined || right === undefined || left === "" || right === "") return null;
	const ahead = Number(left);
	const behind = Number(right);
	if (!Number.isInteger(ahead) || !Number.isInteger(behind) || ahead < 0 || behind < 0) return null;
	return { ahead, behind };
}

function trackingOf(cwd: string, entry: WorktreeEntry, refs: Map<string, UpstreamRow> | null, current: boolean, deadline: number): WorktreeState {
	const base = { path: resolve(entry.path), current, branch: entry.branch, bare: entry.bare, upstream: null, ahead: null, behind: null };
	if (entry.bare) return { ...base, branch: null, tracking: "unavailable" };
	if (entry.detached || entry.branch === null) return { ...base, branch: null, tracking: "detached" };
	if (refs === null) return { ...base, tracking: "unavailable" };
	const row = refs.get(`refs/heads/${entry.branch}`);
	if (row === undefined) return { ...base, tracking: "unavailable" };
	if (row.ref === "") return { ...base, tracking: "no-upstream" };
	const upstream = row.short === "" ? row.ref : row.short;
	const counts = divergence(cwd, `refs/heads/${entry.branch}`, row.ref, deadline);
	if (counts === null) return { ...base, upstream, tracking: "unmeasured" };
	return { ...base, upstream, tracking: "tracked", ahead: counts.ahead, behind: counts.behind };
}

/** What the current tree's publication state proves, never more than that. */
function publicationFindings(state: WorktreeState): HygieneFinding[] {
	switch (state.tracking) {
		case "detached":
			return [{ kind: "publication", status: "ambiguous", description: "HEAD is detached, so no branch upstream exists; publication cannot be inferred." }];
		case "unavailable":
			return [{ kind: "publication", status: "ambiguous", description: "Upstream configuration is unavailable; publication cannot be inferred." }];
		case "no-upstream":
			return [
				{
					kind: "publication",
					status: "ambiguous",
					description: `Branch ${state.branch} has no upstream, so nothing proves it was published; do not classify it as landed.`,
				},
			];
		case "unmeasured":
			return [
				{
					kind: "publication",
					status: "ambiguous",
					description: `Branch ${state.branch} records upstream ${state.upstream}, but its divergence could not be counted; publication state requires review.`,
				},
			];
		case "tracked": {
			const findings: HygieneFinding[] = [];
			if ((state.ahead ?? 0) > 0)
				findings.push({
					kind: "unpushed",
					status: "actionable",
					description: `Branch ${state.branch} is ${state.ahead} commit(s) ahead of ${state.upstream}; do not classify it as landed.`,
				});
			if ((state.behind ?? 0) > 0)
				findings.push({
					kind: "upstream",
					status: "actionable",
					description: `Branch ${state.branch} is ${state.behind} commit(s) behind ${state.upstream}; publication state requires review.`,
				});
			return findings;
		}
	}
}

type PathProof = { ok: true } | { ok: false; reason: "absent" | "symlink" | "not-directory" | "unreadable"; at: string };

/** `path` is a real directory, and is not a symlink standing in for one. */
function provenDirectory(path: string): PathProof {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		const absent = code === "ENOENT" || code === "ENOTDIR";
		return { ok: false, reason: absent ? "absent" : "unreadable", at: path };
	}
	if (stat.isSymbolicLink()) return { ok: false, reason: "symlink", at: path };
	if (!stat.isDirectory()) return { ok: false, reason: "not-directory", at: path };
	return { ok: true };
}

function untrustedReceipts(description: string, paths?: string[]): HygieneFinding {
	return { kind: "receipts", status: "ambiguous", description, paths };
}

const PROOF_TEXT: Record<"symlink" | "not-directory" | "unreadable", string> = {
	symlink: "a symlink",
	"not-directory": "not a directory",
	unreadable: "unreadable",
};

function receiptResidue(cwd: string): HygieneFinding | null {
	const key = repoKey(cwd);
	if (!key) return untrustedReceipts("Receipt state is unavailable because the canonical Git repository key could not be proved.");
	let receipts: string;
	let dir: string;
	try {
		receipts = receiptDirectory(process.env);
		dir = receiptDirectory(process.env, key);
	} catch {
		return untrustedReceipts("Receipt directory could not be resolved from a validated agent root.");
	}
	if (!isAbsolute(receipts) || !isAbsolute(dir)) return untrustedReceipts("Receipt directory is not absolute; receipt state is untrusted.");
	/*
	 * Every component the receipt path is composed of, outermost first: the agent
	 * root, `<agentRoot>/receipts`, and the repository-keyed directory under it.
	 * Each is lstat'd in its own right, because lstat only refuses to follow the
	 * final component — checking the leaf alone silently traverses a symlink
	 * planted at `<agentRoot>/receipts` and reports whatever it points at as this
	 * repository's reconciliation evidence.
	 */
	for (const component of [dirname(receipts), receipts, dir]) {
		const proof = provenDirectory(component);
		if (proof.ok) continue;
		if (proof.reason === "absent") return null;
		return untrustedReceipts(`Receipt path component ${proof.at} is ${PROOF_TEXT[proof.reason]}; receipt state is untrusted.`, [proof.at]);
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return untrustedReceipts("Receipt directory could not be safely read; do not infer cleanup eligibility.", [dir]);
	}
	if (entries.length > MAX_RECEIPTS) return untrustedReceipts("Receipt directory exceeds the bounded scan limit; receipt state is incomplete.", [dir]);
	const paths: string[] = [];
	const invalid: string[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".json")) continue;
		const path = join(dir, entry.name);
		let stat: Stats;
		try {
			stat = lstatSync(path);
		} catch {
			invalid.push(path);
			continue;
		}
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
			invalid.push(path);
			continue;
		}
		paths.push(path);
		if (!readReceipt(path).ok) invalid.push(path);
	}
	if (!paths.length && !invalid.length) return null;
	return {
		kind: "receipts",
		status: invalid.length ? "ambiguous" : "actionable",
		description: invalid.length
			? "Receipt residue includes malformed, hostile, or unsupported object(s); reconciliation proof is ambiguous."
			: `${paths.length} valid landing receipt(s) remain for reconciliation review.`,
		paths: [...new Set([...paths, ...invalid])],
	};
}

function externalState(cwd: string, findings: HygieneFinding[], limitations: string[], deadline: number): void {
	if (!available(git(cwd, ["remote", "get-url", "origin"], deadline))) {
		findings.push({ kind: "forge", status: "ambiguous", description: "Forge publication evidence is unavailable; landed cleanup cannot be inferred." });
		limitations.push("Forge state was unavailable.");
	}
	if (!available(run(["bd", "list", "--limit", "1", "--json"], cwd, deadline))) {
		findings.push({ kind: "beads", status: "ambiguous", description: "Beads state is unavailable; reconciliation and cleanup eligibility cannot be inferred." });
		limitations.push("Beads state was unavailable.");
	}
}

export function scanHygiene(cwd: string): HygieneReport {
	const deadline = Date.now() + SCAN_BUDGET_MS;
	const root = resolve(cwd);
	const realRoot = realOrSelf(root);
	const findings: HygieneFinding[] = [];
	const limitations: string[] = [];

	const commonResult = git(root, ["rev-parse", "--git-common-dir"], deadline);
	let common: string | null = null;
	if (available(commonResult)) {
		const candidate = resolve(root, commonResult.stdout.trim());
		try {
			common = realpathSync(candidate);
		} catch {
			common = null;
		}
	}
	if (!common)
		findings.push({
			kind: "git",
			status: "ambiguous",
			description: "Git common-dir is unavailable or cannot be realpathed; owned repository scope cannot be established.",
		});

	const listed = common ? git(root, ["worktree", "list", "--porcelain"], deadline) : NOT_RUN;
	if (common && !available(listed)) {
		findings.push({ kind: "worktrees", status: "ambiguous", description: "Git's worktree list is unavailable; linked worktrees could not be inventoried." });
		limitations.push("Worktree inventory was unavailable.");
	}
	const listedEntries = available(listed) ? parseWorktrees(listed.stdout) : [];
	let entries = listedEntries;
	if (listedEntries.length > MAX_WORKTREES) {
		entries = listedEntries.slice(0, MAX_WORKTREES);
		findings.push({
			kind: "worktrees",
			status: "ambiguous",
			description: `Repository has ${listedEntries.length} linked worktrees, above the bounded inventory limit of ${MAX_WORKTREES}; the inventory is incomplete.`,
		});
		limitations.push("Worktree inventory was truncated.");
	}
	const refs = common ? upstreamRefs(root, deadline) : null;
	const currentEntry = entries.find(entry => realOrSelf(entry.path) === realRoot);
	const worktrees = entries.map(entry => trackingOf(root, entry, refs, entry === currentEntry, deadline));
	const current = worktrees.find(state => state.current) ?? null;
	if (!current)
		findings.push({
			kind: "scope",
			status: "ambiguous",
			description: "Current path is not present in Git's owned worktree list; ownership of this tree cannot be proved.",
		});

	const status = common ? git(root, ["status", "--porcelain=v1", "-z", "-b"], deadline) : NOT_RUN;
	if (!available(status))
		findings.push({ kind: "git", status: "ambiguous", description: "Git status is unavailable, timed out, or was killed; dirty state is unknown." });
	else {
		const dirty = parsePorcelainPaths(status.stdout);
		if (dirty.length)
			findings.push({
				kind: "dirty",
				status: "actionable",
				description: `${dirty.length} current-worktree path(s) are dirty; review before cleanup.`,
				paths: dirty,
			});
	}

	if (current) findings.push(...publicationFindings(current));
	else if (common) limitations.push("Publication state of the current tree was unavailable.");

	const others = worktrees.filter(state => !state.current);
	if (others.length) {
		const unpushed = others.filter(state => state.tracking === "tracked" && (state.ahead ?? 0) > 0);
		const unproven = others.filter(state => state.tracking !== "tracked");
		const inventoryStatus: HygieneStatus = unpushed.length ? "actionable" : unproven.length ? "ambiguous" : "clean";
		const qualifiers = [
			unpushed.length ? `${unpushed.length} with unpushed commits` : "",
			unproven.length ? `${unproven.length} with unproven upstream state` : "",
		].filter(text => text !== "");
		findings.push({
			kind: "linked-worktrees",
			status: inventoryStatus,
			description: `${others.length} other linked worktree(s) share this repository${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}; each is reported with its branch and exact ahead/behind counts.`,
			paths: others.map(state => state.path),
		});
		if (current?.branch) {
			const duplicates = others.filter(state => state.branch === current.branch).map(state => state.path);
			if (duplicates.length)
				findings.push({
					kind: "duplicate-work",
					status: "ambiguous",
					description: `Another owned worktree uses branch ${current.branch}; cleanup requires explicit ownership proof.`,
					paths: duplicates,
				});
		}
	}

	const receipt = receiptResidue(root);
	if (receipt) findings.push(receipt);
	externalState(root, findings, limitations, deadline);

	const statusValue: HygieneStatus = findings.some(finding => finding.status === "ambiguous")
		? "ambiguous"
		: findings.some(finding => finding.status === "actionable")
			? "actionable"
			: "clean";
	return {
		scope: { cwd: root, commonGitDir: common, currentWorktree: current?.path ?? null },
		worktrees,
		status: statusValue,
		findings,
		limitations,
		mutation: "none",
	};
}

export default function hygieneOrientation(pi: ExtensionAPI): void {
	const z = pi.zod;
	const parameters = z.object({}) as unknown as TSchema;
	const execute = async (_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) => {
		const report = scanHygiene(ctx.cwd);
		const text = `delivery_hygiene_report: ${report.status}\n${JSON.stringify(report, null, 2)}`;
		return { content: [{ type: "text" as const, text }], details: report };
	};
	pi.registerTool({
		name: "delivery_orient",
		label: "Delivery Orientation",
		description:
			"Read-only orientation for the main agent or run lead. Inspect only the current owned repository; invocation guidance is explicit and does not enforce runtime role identity.",
		parameters,
		approval: "read",
		execute,
	});
	pi.registerTool({
		name: "delivery_hygiene_report",
		label: "Delivery Hygiene Report",
		description: "Read-only report of current owned repository hygiene. It never mutates state and recommends the report-only reaper only for ambiguity.",
		parameters,
		approval: "read",
		execute,
	});
}
