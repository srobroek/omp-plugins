import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * Refuse a worktree removal that would leave a commit unreachable.
 *
 * `wt remove` and `git worktree remove` delete a checkout whose HEAD is detached and report
 * only "no branch to delete": the tip loses its last reference and survives solely as an
 * unreferenced object until it is collected. A detached tip that happens to be contained in
 * another ref is safe, but containment is luck unless it is measured, so this gate measures it
 * and blocks the removal when nothing else reaches the tip.
 *
 * The same command accepts several targets at once, which sweeps unrelated checkouts and
 * destroys the per-target evidence that makes each removal auditable, so a multi-target
 * invocation is refused as well.
 *
 * Fail-closed applies only to a detected removal: an unparseable or unprovable removal is
 * refused, while every other bash call is left alone (`skill://omp-extension-safety`).
 */

const TIMEOUT_MS = 5_000;
const MAX_COMMAND_LENGTH = 64_000;

/** Wrappers that pass their tail through to another command. */
const PASSTHROUGH: Record<string, true> = {
	sudo: true, env: true, nohup: true, time: true, command: true, doas: true,
};
/** Wrappers that rebuild a command out of data this gate cannot see. */
const INDIRECT: Record<string, true> = {
	xargs: true, eval: true, sh: true, bash: true, zsh: true, dash: true, fish: true, ssh: true, parallel: true,
};

const WT_BINARIES: Record<string, true> = { wt: true, worktrunk: true };

/** Flags that take a separate value, so the value is never a removal target. */
const VALUE_FLAGS: Record<string, true> = {
	"-C": true, "--config": true, "--git-dir": true, "--work-tree": true, "--reason": true, "--repo": true,
};

/** A removal spelled inside a wrapper's argument, where it is text rather than words. */
const REMOVAL_TEXT = /(?:^|[\s;&|'"])(?:wt|worktrunk)\s+(?:remove|rm)\b|worktree\s+(?:remove|rm)\b/;

export type Segment = { words: string[]; safe: boolean };

/**
 * Split a command into segments of literal shell words. `safe` is false when a segment
 * carries expansion, substitution, globbing, or redirection, so its words cannot be trusted
 * to name what the shell will actually pass.
 */
export function segments(command: string): Segment[] {
	const out: Segment[] = [];
	let words: string[] = [];
	let safe = true;
	let word: string | null = null;
	const endWord = () => {
		if (word !== null) words.push(word);
		word = null;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) out.push({ words, safe });
		words = [];
		safe = true;
	};
	const add = (text: string) => {
		word = (word ?? "") + text;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i] as string;
		if (c === "'") {
			const close = command.indexOf("'", i + 1);
			if (close < 0) {
				safe = false;
				add(command.slice(i + 1));
				break;
			}
			add(command.slice(i + 1, close));
			i = close;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let body = "";
			for (; j < command.length && command[j] !== '"'; j++) {
				if (command[j] === "\\") {
					body += command[j + 1] ?? "";
					j++;
					continue;
				}
				body += command[j];
			}
			if (j >= command.length) safe = false;
			if (/[$`]/.test(body)) safe = false;
			add(body);
			i = j;
			continue;
		}
		if (c === "\\") {
			add(command[i + 1] ?? "");
			i++;
			continue;
		}
		if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "{" || c === "}") {
			endSegment();
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			endWord();
			continue;
		}
		if (c === "$" || c === "`" || c === "*" || c === "?" || c === "<" || c === ">") {
			safe = false;
			add(c);
			continue;
		}
		add(c);
	}
	endSegment();
	return out;
}

function basename(word: string): string {
	const cut = word.lastIndexOf("/");
	return cut < 0 ? word : word.slice(cut + 1);
}

export type Removal = {
	/** `-C` directory named on the command, relative to the call's own cwd. */
	chdir: string | null;
	targets: string[];
	/** False when the invocation was recognised but its words cannot be trusted. */
	literal: boolean;
};

/** Recognise worktree removals in a command. */
export function removals(command: string): Removal[] {
	const found: Removal[] = [];
	for (const segment of segments(command)) {
		let words = segment.words;
		// Own-property lookups: `table["constructor"]` would otherwise be truthy through the prototype.
		while (words.length > 0 && (Object.hasOwn(PASSTHROUGH, basename(words[0] as string)) || (words[0] as string).includes("="))) {
			words = words.slice(1);
		}
		const head = basename(words[0] ?? "");
		if (Object.hasOwn(INDIRECT, head)) {
			// A wrapper carries the removal inside its own argument, where the target words are
			// no longer separate words this gate can resolve.
			if (REMOVAL_TEXT.test(words.slice(1).join(" "))) {
				found.push({ chdir: null, targets: [], literal: false });
			}
			continue;
		}
		const rest = words;
		const isGit = rest.some((w, i) => basename(w) === "git" && rest.slice(i + 1).includes("worktree"));
		const isWt = rest.some((w) => Object.hasOwn(WT_BINARIES, basename(w)));
		if (!isGit && !isWt) continue;
		const verbIndex = rest.findIndex((w) => w === "remove" || w === "rm");
		if (verbIndex < 0) continue;
		if (!segment.safe) {
			found.push({ chdir: null, targets: [], literal: false });
			continue;
		}
		let chdir: string | null = null;
		const targets: string[] = [];
		let afterDoubleDash = false;
		for (let i = verbIndex + 1; i < rest.length; i++) {
			const word = rest[i] as string;
			if (!afterDoubleDash && word === "--") {
				afterDoubleDash = true;
				continue;
			}
			if (!afterDoubleDash && Object.hasOwn(VALUE_FLAGS, word)) {
				i++;
				continue;
			}
			if (!afterDoubleDash && word.startsWith("-")) continue;
			targets.push(word);
		}
		for (let i = 0; i < verbIndex; i++) {
			if (rest[i] === "-C" && rest[i + 1] !== undefined) chdir = rest[i + 1] as string;
		}
		found.push({ chdir, targets, literal: true });
	}
	return found;
}

export type WorktreeRecord = { path: string; head: string; detached: boolean; branch: string };

export type GitProbe = {
	/** Live worktrees, or null when the inventory cannot be read. */
	list: (cwd: string) => WorktreeRecord[] | null;
	/** Refs that reach the commit, or null when containment cannot be determined. */
	containingRefs: (cwd: string, sha: string) => string[] | null;
	resolve: (cwd: string, target: string) => string;
};

export function parseWorktreeList(porcelain: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	let current: WorktreeRecord | null = null;
	for (const line of porcelain.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) records.push(current);
			current = { path: line.slice("worktree ".length), head: "", detached: false, branch: "" };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		else if (line.trim() === "detached") current.detached = true;
	}
	if (current) records.push(current);
	return records;
}

function matchTarget(target: string, cwd: string, worktrees: WorktreeRecord[], probe: GitProbe): WorktreeRecord | null {
	const resolved = probe.resolve(cwd, target);
	const byPath = worktrees.find((w) => probe.resolve(cwd, w.path) === resolved);
	if (byPath) return byPath;
	const named = worktrees.filter((w) => basename(w.path) === target || w.branch === target);
	return named.length === 1 ? (named[0] as WorktreeRecord) : null;
}

/** The refusal a removal earns, or null when it cannot orphan a commit. */
export function reviewRemoval(removal: Removal, cwd: string, probe: GitProbe): string | null {
	if (!removal.literal) {
		return "Worktree removal refused: this call builds its targets through a wrapper or shell expansion, so the checkouts it would delete cannot be identified. Name each worktree path literally, one removal per call.";
	}
	if (removal.targets.length === 0) return null;
	if (removal.targets.length > 1) {
		return `Worktree removal refused: ${removal.targets.length} targets in one call (${removal.targets.join(", ")}). One removal per call keeps each checkout's containment evidence auditable.`;
	}
	const target = removal.targets[0] as string;
	const base = removal.chdir ? probe.resolve(cwd, removal.chdir) : cwd;
	const worktrees = probe.list(base);
	if (worktrees === null) {
		return "Worktree removal refused: `git worktree list` did not answer, so this call cannot prove the checkout's tip stays reachable. Re-run it where the repository is readable.";
	}
	const record = matchTarget(target, base, worktrees, probe);
	if (!record) return null;
	if (!record.detached) return null;
	const refs = probe.containingRefs(base, record.head);
	if (refs === null) {
		return `Worktree removal refused: ${target} is detached at ${record.head} and its containment could not be determined. Mint a rescue ref first: git branch recovered/${basename(record.path)} ${record.head}`;
	}
	if (refs.length > 0) return null;
	return `Worktree removal refused: ${target} is detached at ${record.head} and no ref reaches that commit, so removing the checkout orphans it — git reports only "no branch to delete". Mint a rescue ref first: git branch recovered/${basename(record.path)} ${record.head}`;
}

export function defaultProbe(): GitProbe {
	return {
		list: (cwd) => {
			try {
				const proc = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
					cwd, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS,
				});
				if (proc.exitCode !== 0) return null;
				return parseWorktreeList(proc.stdout.toString());
			} catch {
				return null;
			}
		},
		containingRefs: (cwd, sha) => {
			if (!/^[0-9a-f]{7,64}$/.test(sha)) return null;
			try {
				const proc = Bun.spawnSync(["git", "for-each-ref", "--contains", sha, "--count=1", "--format=%(refname)"], {
					cwd, stdout: "pipe", stderr: "pipe", timeout: TIMEOUT_MS,
				});
				if (proc.exitCode !== 0) return null;
				return proc.stdout.toString().split("\n").filter((line) => line.trim() !== "");
			} catch {
				return null;
			}
		},
		resolve: (cwd, target) => {
			const absolute = resolve(cwd, target);
			try {
				// Worktree paths and command arguments reach the same checkout through symlinks
				// (macOS /tmp is one), so containment must compare resolved paths.
				return realpathSync(absolute);
			} catch {
				return absolute;
			}
		},
	};
}

function commandOf(event: ToolCallEvent): string {
	const raw = event.input;
	if ("command" in raw && typeof raw.command === "string") return raw.command;
	return "";
}

function cwdOf(event: ToolCallEvent, fallback: string): string {
	const raw = event.input;
	if ("cwd" in raw && typeof raw.cwd === "string" && raw.cwd !== "") return raw.cwd;
	return fallback;
}

/** The refusal a bash command earns, or null when nothing in it can orphan a commit. */
export type RemovalParser = (command: string) => Removal[];

export function reviewCommand(command: string, cwd: string, probe: GitProbe, parse: RemovalParser = removals): string | null {
	const mayContainRemoval = (command.includes("remove") || command.includes(" rm")) &&
		(command.includes("worktree") || /(^|[^\w/-])(wt|worktrunk)([^\w-]|$)/.test(command));
	if (!mayContainRemoval) return null;
	if (command.length > MAX_COMMAND_LENGTH) {
		return "Worktree removal refused: command exceeds the 64 KiB safety limit (oversize), so its removal cannot be checked.";
	}
	try {
		for (const removal of parse(command)) {
			const refusal = reviewRemoval(removal, cwd, probe);
			if (refusal) return refusal;
		}
	} catch {
		return "Worktree removal refused: parse failure while checking a removal command; its impact could not be proved.";
	}
	return null;
}

export default function worktreeDetachedGuard(pi: ExtensionAPI, probe: GitProbe = defaultProbe(), parse: RemovalParser = removals): void {
	pi.on("tool_call", (event) => {
		let refusal: string | null = null;
		try {
			if (event.toolName !== "bash") return;
			const command = commandOf(event);
			if (!command) return;
			refusal = reviewCommand(command, cwdOf(event, process.cwd()), probe, parse);
		} catch {
			// An internal failure must not take bash down; unrelated calls stay allowed.
			return;
		}
		if (refusal) throw new Error(refusal);
	});
}
