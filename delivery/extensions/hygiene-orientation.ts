import type { Dir, Stats } from "node:fs";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type { GitRunner } from "./landing-receipt";
import { listReceipts, receiptDirectory, repoKey } from "./landing-receipt";

/**
 * Read-only hygiene inventory for one repository.
 *
 * This module registers `delivery_hygiene_report`; the six-point hygiene contract
 * lives in the delivery-worktree-hygiene rule. The report answers each question
 * from Git primitives whose exit codes distinguish "no" from "could not tell".
 * Nothing here mutates, and no absence of evidence is reported as cleanliness.
 */

/** A value this scan could not prove. It is never promoted to a measurement. */
export const UNKNOWN = "unknown";
export type Unknown = typeof UNKNOWN;

/**
 * One finished probe.
 *
 * `refused` is set only by {@link run} when the allowlist rejected the argv, in
 * which case no child process was ever created.
 */
export type ProbeResult = {
	exitCode: number;
	signalCode: string | number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	refused?: boolean;
};

/**
 * The child-process seam: a full argv including its binary, a working directory
 * and a bound in milliseconds.
 *
 * Injected so a test can drive a probe that times out or fails without depending
 * on the ambient machine, and so the allowlist can be proved against exactly the
 * argv a runner is asked to execute. Unlike landing-receipt's {@link GitRunner}
 * this carries the binary, because the scan also reads Beads state.
 */
export type ProbeRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => ProbeResult;

export type HygieneStatus = "actionable" | "ambiguous" | "clean";

export type HygieneFinding = { kind: string; status: HygieneStatus; description: string; paths?: string[] };

/** How much a branch's publication state could be proved. */
export type TrackingKind = "tracked" | "no-upstream" | "detached" | "unmeasured" | "unavailable";

/**
 * Which party holds a worktree.
 *
 * There is no third value. `this-scan` is the tree the scan itself runs in, the
 * only tree whose holder is observable. Every other tree — a sibling on another
 * branch, a path outside this repository, a branch another actor created — is
 * `unknown`, because ExtensionContext carries no agent identity and nothing in
 * this module may claim to read one.
 */
export type OwnerKind = "this-scan" | Unknown;

/** How a row entered the inventory. */
export type RowOrigin = "git-worktree-list" | "scan-path";

/**
 * One worktree of the repository, current or not.
 *
 * Every tree Git owns appears here, not only the ones sharing the current
 * branch: a sibling tree on another branch still holds work, and omitting it
 * makes the inventory look empty when it is not. A `scan-path` row appears when
 * Git disowns the path the scan was started from.
 */
export type WorktreeState = {
	path: string;
	origin: RowOrigin;
	current: boolean;
	/** Whether this is the repository's main worktree, proved from the common git dir. */
	main: boolean | Unknown;
	branch: string | null;
	bare: boolean;
	tracking: TrackingKind;
	upstream: string | null;
	/** Commits on the branch and not on its upstream; null unless `tracking` is `tracked`. */
	ahead: number | null;
	/** Commits on the upstream and not on the branch; null unless `tracking` is `tracked`. */
	behind: number | null;
	/** Paths dirty in this tree, counted in the tree itself; `unknown` when unmeasurable. */
	dirty: number | Unknown;
	owner: OwnerKind;
	/** The only recommendation any row carries, and never a removal. Null when the scan holds the tree. */
	handOff: string | null;
};

export type HygieneReport = {
	scope: { cwd: string; commonGitDir: string | null; currentWorktree: string | null; mainWorktree: string | Unknown };
	worktrees: WorktreeState[];
	/** Receipt evidence for this repository's key, read through the receipt module. */
	receipts: { directory: string | null; ids: string[] | Unknown };
	status: HygieneStatus;
	findings: HygieneFinding[];
	limitations: string[];
	mutation: "none";
};

/** Bound on one child process. A scan runs at an interactive boundary. */
const TIMEOUT_MS = 2000;

/**
 * Bound on the whole scan. A repository with many worktrees would otherwise cost
 * one unbounded divergence count and one status per tree; past the budget the
 * remaining trees are reported as unprovable rather than measured.
 */
const SCAN_BUDGET_MS = 10_000;

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKTREES = 64;
const MAX_RECEIPTS = 256;
const MAX_RECEIPT_BYTES = 1024 * 1024;

/** The word and flag every git probe shares: no probe may take an optional index lock. */
const GIT: readonly string[] = ["git", "--no-optional-locks"];

/**
 * One permitted command: an exact argv, plus — for the single probe that needs
 * one — a validator for exactly one trailing argument.
 */
type Allowed = { argv: readonly string[]; trailing?: (value: string) => boolean };

/**
 * A `<branch>...<upstream>` symmetric-difference operand.
 *
 * Both sides must be fully qualified refs, so no operand can begin with `-` and
 * be read as an option, and neither may carry whitespace.
 */
const REF_RANGE = /^refs\/heads\/\S+\.\.\.refs\/\S+$/;

/**
 * Every command this module may run, fixed and read-only.
 *
 * An argv that does not match one of these entries exactly is refused before any
 * child process exists, so a later edit cannot smuggle a write verb, an extra
 * path operand or a different binary through the runner. Each entry is a whole
 * command, not a prefix: matching a prefix would accept `git status --porcelain
 * <anything>`.
 */
const ALLOWLIST: readonly Allowed[] = [
	{ argv: [...GIT, "rev-parse", "--git-common-dir"] },
	{ argv: [...GIT, "worktree", "list", "--porcelain"] },
	{ argv: [...GIT, "status", "--porcelain=v1", "-z", "-b"] },
	{ argv: [...GIT, "for-each-ref", "--format=%(refname)%09%(upstream)%09%(upstream:short)", "refs/heads/"] },
	{ argv: [...GIT, "rev-list", "--left-right", "--count"], trailing: value => REF_RANGE.test(value) },
	{ argv: [...GIT, "remote", "get-url", "origin"] },
	{ argv: ["bd", "list", "--limit", "1", "--json"] },
];

/** Whether `argv` is one of the {@link ALLOWLIST} commands, exactly. */
export function permitted(argv: readonly string[]): boolean {
	for (const allowed of ALLOWLIST) {
		const fixed = allowed.argv;
		const expected = allowed.trailing === undefined ? fixed.length : fixed.length + 1;
		if (argv.length !== expected) continue;
		if (!fixed.every((word, index) => argv[index] === word)) continue;
		if (allowed.trailing === undefined) return true;
		const tail = argv[fixed.length];
		if (tail !== undefined && allowed.trailing(tail)) return true;
	}
	return false;
}

/** The default runner: one bounded, output-capped child process per probe. */
export const spawnProbe: ProbeRunner = (argv, cwd, timeoutMs) => {
	try {
		const child = Bun.spawnSync([...argv], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: Math.max(1, timeoutMs),
			killSignal: 9,
			maxBuffer: MAX_OUTPUT_BYTES,
		});
		// Bun reports a killed-on-timeout child through a field its published type omits.
		const timedOut = "exitedDueToTimeout" in child && child.exitedDueToTimeout === true;
		return {
			exitCode: child.exitCode,
			signalCode: child.signalCode ?? null,
			stdout: child.stdout.toString(),
			stderr: child.stderr.toString(),
			timedOut,
		};
	} catch (error) {
		return { exitCode: 127, signalCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
	}
};

/**
 * The scan's working state.
 *
 * Carried as one value so a probe site records its own incompleteness without
 * every helper taking four positional arguments that must stay in step.
 */
type Scan = {
	root: string;
	deadline: number;
	runner: ProbeRunner;
	findings: HygieneFinding[];
	limitations: string[];
	/**
	 * One child per distinct command and directory. The common-dir read is asked
	 * for twice — once here and once by {@link repoKey} — and a repeated probe
	 * would spend a second child on an answer already held.
	 */
	memo: Map<string, ProbeResult>;
};

function run(argv: readonly string[], cwd: string, scan: Scan): ProbeResult {
	if (!permitted(argv)) return { exitCode: 126, signalCode: null, stdout: "", stderr: "argv is not in the read-only allowlist", timedOut: false, refused: true };
	const remaining = scan.deadline - Date.now();
	if (remaining <= 0) return { exitCode: 124, signalCode: null, stdout: "", stderr: "scan budget exhausted", timedOut: true };
	const cacheKey = [cwd, ...argv].join("\0");
	const held = scan.memo.get(cacheKey);
	if (held !== undefined) return held;
	const result = scan.runner(argv, cwd, Math.min(TIMEOUT_MS, remaining));
	scan.memo.set(cacheKey, result);
	return result;
}

function available(result: ProbeResult): boolean {
	return result.exitCode === 0 && !result.timedOut && result.refused !== true && (result.signalCode === null || result.signalCode === 0);
}

/** Why a probe produced no answer, in the words the report states it in. */
function reasonOf(result: ProbeResult): string {
	if (result.refused === true) return "refused: the argv is not in the read-only allowlist";
	if (result.timedOut) return result.exitCode === 124 ? "not run: the scan budget was exhausted" : "timed out";
	if (result.signalCode !== null && result.signalCode !== 0) return `killed by signal ${result.signalCode}`;
	if (result.exitCode === 127) return "could not be executed";
	return `exited ${result.exitCode}`;
}

/**
 * One probe, with its incompleteness recorded.
 *
 * Every incomplete probe — refused, timed out, killed, absent or non-zero — adds
 * one line naming the command and the reason, so a field reported as unknown is
 * always traceable to the probe that could not answer it.
 */
function probe(scan: Scan, argv: readonly string[], cwd: string): ProbeResult {
	const result = run(argv, cwd, scan);
	// The probe is named as a consumer would name it, without the flag every git probe carries.
	if (!available(result))
		scan.limitations.push(`Probe \`${argv.filter(word => word !== "--no-optional-locks").join(" ")}\` in ${cwd} was incomplete: ${reasonOf(result)}.`);
	return result;
}

function git(scan: Scan, args: readonly string[], cwd: string): ProbeResult {
	return probe(scan, [...GIT, ...args], cwd);
}

/**
 * {@link repoKey}'s git seam, routed through this scan.
 *
 * The receipt module owns the key algorithm, and this module owns the execution
 * bounds; routing its one command through here keeps every child of the scan
 * inside one allowlist and one budget. Its runner omits the `git` word and wants
 * trimmed stdout or null.
 */
function keyRunner(scan: Scan): GitRunner {
	return (argv, cwd) => {
		const result = git(scan, argv, cwd);
		return available(result) ? result.stdout.trim() : null;
	};
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
function upstreamRefs(scan: Scan): Map<string, UpstreamRow> | null {
	const result = git(scan, ["for-each-ref", "--format=%(refname)%09%(upstream)%09%(upstream:short)", "refs/heads/"], scan.root);
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
function divergence(scan: Scan, branchRef: string, upstreamRef: string): { ahead: number; behind: number } | null {
	const result = git(scan, ["rev-list", "--left-right", "--count", `${branchRef}...${upstreamRef}`], scan.root);
	if (!available(result)) return null;
	const [left, right] = result.stdout.trim().split(/\s+/);
	if (left === undefined || right === undefined || left === "" || right === "") return null;
	const ahead = Number(left);
	const behind = Number(right);
	if (!Number.isInteger(ahead) || !Number.isInteger(behind) || ahead < 0 || behind < 0) return null;
	return { ahead, behind };
}

/**
 * The hand-off every tree the scan does not hold carries.
 *
 * It names no removal, because nothing here establishes who holds the tree and a
 * report that cannot name a holder has no standing to propose deleting its work.
 */
const HAND_OFF = "The party holding this tree is not established by this report; hand it to that party and treat its contents as another actor's work.";

/**
 * Whether `entry` is the repository's main worktree.
 *
 * Proved from the common git directory rather than from the order
 * `git worktree list` happens to print: the main worktree is the one whose
 * `.git` resolves to the common directory, and a bare repository is its own.
 * `unknown` when the common directory could not be established.
 */
function mainOf(entry: WorktreeEntry, common: string | null): boolean | Unknown {
	if (common === null) return UNKNOWN;
	const anchor = entry.bare ? entry.path : join(entry.path, ".git");
	return realOrSelf(anchor) === common;
}

/** Paths dirty in one tree, or `unknown` when the count could not be taken. */
function dirtyPaths(scan: Scan, cwd: string): string[] | Unknown {
	const result = git(scan, ["status", "--porcelain=v1", "-z", "-b"], cwd);
	if (!available(result)) return UNKNOWN;
	return parsePorcelainPaths(result.stdout);
}

function trackingOf(scan: Scan, entry: WorktreeEntry, refs: Map<string, UpstreamRow> | null): Pick<WorktreeState, "tracking" | "upstream" | "ahead" | "behind"> {
	const none = { upstream: null, ahead: null, behind: null };
	if (entry.bare) return { ...none, tracking: "unavailable" };
	if (entry.detached || entry.branch === null) return { ...none, tracking: "detached" };
	if (refs === null) return { ...none, tracking: "unavailable" };
	const row = refs.get(`refs/heads/${entry.branch}`);
	if (row === undefined) return { ...none, tracking: "unavailable" };
	if (row.ref === "") return { ...none, tracking: "no-upstream" };
	const upstream = row.short === "" ? row.ref : row.short;
	const counts = divergence(scan, `refs/heads/${entry.branch}`, row.ref);
	if (counts === null) return { ...none, upstream, tracking: "unmeasured" };
	return { upstream, tracking: "tracked", ahead: counts.ahead, behind: counts.behind };
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

const PROOF_TEXT: Record<"symlink" | "not-directory" | "unreadable", string> = {
	symlink: "a symlink",
	"not-directory": "not a directory",
	unreadable: "unreadable",
};

type Enumerated = { candidates: string[]; hostile: string[]; overflowed: boolean };

/**
 * One streamed, bounded pass over the receipt directory.
 *
 * `opendirSync` yields one entry at a time, so a directory holding a million
 * files costs the bound rather than the directory. `readdirSync` cannot: it
 * materialises every name before any cap can be applied, which makes the cap
 * describe the result instead of the work.
 *
 * Nothing here parses a receipt. Entries are classified by `lstat` alone, and
 * validation belongs to the receipt module.
 */
function enumerateReceipts(dir: string): Enumerated | null {
	let handle: Dir;
	try {
		handle = opendirSync(dir);
	} catch {
		return null;
	}
	const candidates: string[] = [];
	const hostile: string[] = [];
	let seen = 0;
	let overflowed = false;
	try {
		for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
			seen += 1;
			if (seen > MAX_RECEIPTS) {
				overflowed = true;
				break;
			}
			if (!entry.name.endsWith(".json")) continue;
			const path = join(dir, entry.name);
			let stat: Stats;
			try {
				stat = lstatSync(path);
			} catch {
				hostile.push(path);
				continue;
			}
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
				hostile.push(path);
				continue;
			}
			candidates.push(entry.name);
		}
	} finally {
		try {
			handle.closeSync();
		} catch {
			// The pass is done; a failed close changes nothing about the result.
		}
	}
	return { candidates, hostile, overflowed };
}

type ReceiptState = { finding: HygieneFinding | null; ids: string[] | Unknown; directory: string | null };

/** Receipt evidence that proves nothing: every field it would have carried is unknown. */
function untrustedState(description: string, directory: string | null, paths?: string[]): ReceiptState {
	return { finding: { kind: "receipts", status: "ambiguous", description, paths }, ids: UNKNOWN, directory };
}

/**
 * Receipt evidence for this repository, by id.
 *
 * Ids come from {@link listReceipts}, the receipt module's own bounded reader, so
 * no receipt schema, filename rule or validation lives in two places. This
 * module contributes only what that reader does not: whether the path leading to
 * the directory can be trusted, and which entries are hostile.
 */
function receiptState(scan: Scan): ReceiptState {
	const key = repoKey(scan.root, keyRunner(scan));
	if (!key) return untrustedState("Receipt state is unavailable because the canonical Git repository key could not be proved.", null);
	let receipts: string;
	let dir: string;
	try {
		receipts = receiptDirectory(process.env);
		dir = receiptDirectory(process.env, key);
	} catch {
		return untrustedState("Receipt directory could not be resolved from a validated agent root.", null);
	}
	if (!isAbsolute(receipts) || !isAbsolute(dir)) return untrustedState("Receipt directory is not absolute; receipt state is untrusted.", null);
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
		if (proof.reason === "absent") return { finding: null, ids: [], directory: dir };
		return untrustedState(`Receipt path component ${proof.at} is ${PROOF_TEXT[proof.reason]}; receipt state is untrusted.`, dir, [proof.at]);
	}
	const scanned = enumerateReceipts(dir);
	if (scanned === null) return untrustedState("Receipt directory could not be safely read; do not infer cleanup eligibility.", dir, [dir]);
	if (scanned.overflowed)
		return untrustedState(`Receipt directory holds more than the bounded scan limit of ${MAX_RECEIPTS} entries; receipt state is incomplete.`, dir, [dir]);
	const ids = listReceipts(dir).map(receipt => receipt.receiptId);
	const validated = new Set(ids.map(id => `${id}.json`));
	/*
	 * A candidate the receipt module did not return is either malformed, carries
	 * an unsupported version, or fell outside that module's bounded listing
	 * window. The three are one verdict here — the file proves nothing — and
	 * distinguishing them would mean parsing it a second time.
	 */
	const unvalidated = scanned.candidates.filter(name => !validated.has(name)).map(name => join(dir, name));
	const doubtful = [...scanned.hostile, ...unvalidated];
	if (!ids.length && !doubtful.length) return { finding: null, ids: [], directory: dir };
	const description = doubtful.length
		? `${doubtful.length} receipt entr(ies) are hostile, malformed, or otherwise unvalidated; reconciliation proof is ambiguous.`
		: `${ids.length} valid landing receipt(s) remain for reconciliation review.`;
	return {
		finding: { kind: "receipts", status: doubtful.length ? "ambiguous" : "actionable", description, paths: [...new Set([...doubtful, ...ids.map(id => join(dir, `${id}.json`))])] },
		ids,
		directory: dir,
	};
}

function externalState(scan: Scan): void {
	if (!available(git(scan, ["remote", "get-url", "origin"], scan.root)))
		scan.findings.push({ kind: "forge", status: "ambiguous", description: "Forge publication evidence is unavailable; landed cleanup cannot be inferred." });
	if (!available(probe(scan, ["bd", "list", "--limit", "1", "--json"], scan.root)))
		scan.findings.push({
			kind: "beads",
			status: "ambiguous",
			description: "Beads state is unavailable; reconciliation and cleanup eligibility cannot be inferred.",
		});
}

/**
 * The listed tree holding `realRoot`, longest path first.
 *
 * `git worktree list` prints a tree's top level, so an invocation from a
 * subdirectory matches by containment. Matching by equality alone would report
 * every subdirectory invocation as a path this repository does not own.
 */
function holdingEntry(entries: readonly WorktreeEntry[], realRoot: string): WorktreeEntry | undefined {
	let best: WorktreeEntry | undefined;
	let bestLength = -1;
	for (const entry of entries) {
		const real = realOrSelf(entry.path);
		if (real !== realRoot && !realRoot.startsWith(real.endsWith(sep) ? real : real + sep)) continue;
		if (real.length <= bestLength) continue;
		best = entry;
		bestLength = real.length;
	}
	return best;
}

export function scanHygiene(cwd: string, runner: ProbeRunner = spawnProbe): HygieneReport {
	const root = resolve(cwd);
	const scan: Scan = { root, deadline: Date.now() + SCAN_BUDGET_MS, runner, findings: [], limitations: [], memo: new Map() };
	const { findings } = scan;
	const realRoot = realOrSelf(root);

	const commonResult = git(scan, ["rev-parse", "--git-common-dir"], root);
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

	const listed = common ? git(scan, ["worktree", "list", "--porcelain"], root) : null;
	if (listed !== null && !available(listed))
		findings.push({ kind: "worktrees", status: "ambiguous", description: "Git's worktree list is unavailable; linked worktrees could not be inventoried." });
	const listedEntries = listed !== null && available(listed) ? parseWorktrees(listed.stdout) : [];
	let entries = listedEntries;
	if (listedEntries.length > MAX_WORKTREES) {
		entries = listedEntries.slice(0, MAX_WORKTREES);
		findings.push({
			kind: "worktrees",
			status: "ambiguous",
			description: `Repository has ${listedEntries.length} linked worktrees, above the bounded inventory limit of ${MAX_WORKTREES}; the inventory is incomplete.`,
		});
	}

	const refs = common ? upstreamRefs(scan) : null;
	const currentEntry = holdingEntry(entries, realRoot);
	let currentDirty: string[] | Unknown = UNKNOWN;
	const worktrees: WorktreeState[] = entries.map(entry => {
		const current = entry === currentEntry;
		// A bare repository has no working tree, so no dirty count exists to take.
		const dirty = entry.bare ? UNKNOWN : dirtyPaths(scan, current ? root : entry.path);
		if (current) currentDirty = dirty;
		if (entry.bare) scan.limitations.push(`A bare repository has no working tree, so no dirty count applies to ${entry.path}.`);
		return {
			path: resolve(entry.path),
			origin: "git-worktree-list" as const,
			current,
			main: mainOf(entry, common),
			branch: entry.bare || entry.detached ? null : entry.branch,
			bare: entry.bare,
			...trackingOf(scan, entry, refs),
			dirty: dirty === UNKNOWN ? UNKNOWN : dirty.length,
			owner: current ? ("this-scan" as const) : UNKNOWN,
			handOff: current ? null : HAND_OFF,
		};
	});

	if (!currentEntry) {
		/*
		 * Git does not list a tree holding this path. The path is still where the
		 * scan runs, so it is inventoried rather than dropped — as a row whose
		 * holder is unknown, carrying the same hand-off every unheld tree carries.
		 */
		currentDirty = dirtyPaths(scan, root);
		worktrees.push({
			path: root,
			origin: "scan-path",
			current: true,
			main: UNKNOWN,
			branch: null,
			bare: false,
			tracking: "unavailable",
			upstream: null,
			ahead: null,
			behind: null,
			dirty: currentDirty === UNKNOWN ? UNKNOWN : currentDirty.length,
			owner: UNKNOWN,
			handOff: HAND_OFF,
		});
		findings.push({
			kind: "scope",
			status: "ambiguous",
			description: `Current path is not held by any worktree Git lists, so this repository does not own it; it is reported as unknown. ${HAND_OFF}`,
			paths: [root],
		});
	}

	const current = worktrees.find(state => state.current) ?? null;
	if (currentDirty === UNKNOWN)
		findings.push({ kind: "git", status: "ambiguous", description: "Git status is unavailable, timed out, or was killed; dirty state is unknown." });
	else if (currentDirty.length)
		findings.push({
			kind: "dirty",
			status: "actionable",
			description: `${currentDirty.length} current-worktree path(s) are dirty; review before cleanup.`,
			paths: currentDirty,
		});

	if (current) findings.push(...publicationFindings(current));

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
			description: `${others.length} other linked worktree(s) share this repository${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}; each is reported with its branch, main-worktree flag, dirty count and exact ahead/behind counts, and each is held by a party this report does not establish.`,
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

	const receipts = receiptState(scan);
	if (receipts.finding) findings.push(receipts.finding);
	externalState(scan);

	const statusValue: HygieneStatus = findings.some(finding => finding.status === "ambiguous")
		? "ambiguous"
		: findings.some(finding => finding.status === "actionable")
			? "actionable"
			: "clean";
	const mainWorktree = worktrees.find(state => state.main === true)?.path ?? UNKNOWN;
	return {
		scope: { cwd: root, commonGitDir: common, currentWorktree: current?.path ?? null, mainWorktree },
		worktrees,
		receipts: { directory: receipts.directory, ids: receipts.ids },
		status: statusValue,
		findings,
		limitations: scan.limitations,
		mutation: "none",
	};
}

export default function hygieneOrientation(pi: ExtensionAPI): void {
	const z = pi.zod;
	const parameters = z.object({}) as unknown as TSchema;

	pi.registerTool({
		name: "delivery_hygiene_report",
		label: "Delivery Hygiene Report",
		description:
			"Read-only inventory of the current owned repository: one row per worktree with its branch, main-worktree flag, dirty count and ahead/behind counts, plus the receipt ids present for this repository. It never mutates state and recommends the report-only reaper only for ambiguity.",
		parameters,
		approval: "read",
		execute: async (_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) => {
			const report = scanHygiene(ctx.cwd);
			const text = `delivery_hygiene_report: ${report.status}\n${JSON.stringify(report, null, 2)}`;
			return { content: [{ type: "text" as const, text }], details: report };
		},
	});
}
