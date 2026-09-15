import { isAbsolute, resolve } from "node:path";

export type GitRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

type TreeEntry = { mode: string; type: string; path: string };
type ReadResult = { text: string | null; error: boolean };

function canonicalRoot(target: string, run: GitRun): string | null {
	try {
		const result = run(["git", "rev-parse", "--show-toplevel"], target);
		if (result.exitCode !== 0) return null;
		const raw = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (!raw) return null;
		return isAbsolute(raw) ? resolve(raw) : resolve(target, raw);
	} catch {
		return null;
	}
}

function trustedRef(root: string, run: GitRun): string | null {
	try {
		const head = run(["git", "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], root);
		if (head.exitCode === 0) {
			const ref = head.stdout.trim();
			if (!/^refs\/remotes\/origin\/(?!HEAD(?:\/|$))\S+$/.test(ref)) return null;
			const verified = run(["git", "rev-parse", "--verify", "--quiet", ref], root);
			return verified.exitCode === 0 && verified.stdout.trim() ? ref : null;
		}
		for (const branch of ["main", "master"]) {
			const ref = `refs/remotes/origin/${branch}`;
			const verified = run(["git", "rev-parse", "--verify", "--quiet", ref], root);
			if (verified.exitCode === 0 && verified.stdout.trim()) return ref;
		}
	} catch {}
	return null;
}

function treeEntries(root: string, ref: string, run: GitRun): TreeEntry[] | null {
	try {
		const result = run(
			["git", "ls-tree", "-rz", "--full-tree", "-r", ref, "--", "AGENTS.md", "CLAUDE.md", ".omp"],
			root,
		);
		if (result.exitCode !== 0) return null;
		const entries: TreeEntry[] = [];
		for (const record of result.stdout.split("\0")) {
			if (!record) continue;
			const tab = record.indexOf("\t");
			if (tab < 0) return null;
			const [mode, type] = record.slice(0, tab).split(" ");
			const path = record.slice(tab + 1);
			if (!mode || !type || !path) return null;
			entries.push({ mode, type, path });
		}
		return entries;
	} catch {
		return null;
	}
}

function directSource(path: string): boolean {
	return path === "AGENTS.md" || path === "CLAUDE.md" ||
		(path.startsWith(".omp/rules/") && path.endsWith(".md") && !path.slice(".omp/rules/".length).includes("/"));
}

function readTrustedFile(root: string, ref: string, path: string, run: GitRun): ReadResult {
	try {
		const result = run(["git", "show", `${ref}:${path}`], root);
		if (result.exitCode !== 0) return { text: null, error: true };
		return { text: result.stdout, error: false };
	} catch {
		return { text: null, error: true };
	}
}

function fencedLineScanner(text: string, affirmative: string, veto: string): {
	affirmative: boolean;
	veto: boolean;
} {
	let fence: { char: "`" | "~"; length: number } | undefined;
	let foundAffirmative = false;
	let foundVeto = false;
	for (const line of text.split(/\r?\n/)) {
		if (fence) {
			const close = new RegExp(`^ {0,3}(${fence.char}{${fence.length},})[ \\t]*$`).exec(line);
			if (close) fence = undefined;
			continue;
		}
		const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (open?.[2] && (open[2][0] !== "`" || !open[3]?.includes("`"))) {
			fence = { char: open[2][0] as "`" | "~", length: open[2].length };
			continue;
		}
		if (line === affirmative) foundAffirmative = true;
		if (line === veto) foundVeto = true;
	}
	return { affirmative: foundAffirmative, veto: foundVeto };
}

/**
 * Return whether the target repository's trusted remote default branch authorizes an override.
 *
 * Only exact standalone directive lines outside Markdown fenced code blocks in non-symlink
 * AGENTS.md/CLAUDE.md or direct .omp/rules/*.md tree entries count. The source is read from
 * refs/remotes/origin/HEAD, then origin/main/origin/master, never from the mutable worktree.
 * Missing or unreadable refs/files deny authorization, and a veto wins over every affirmative.
 */
export function targetRepoAuthorizes(target: string, envName: string, run: GitRun): boolean {
	const root = canonicalRoot(target, run);
	if (root === null) return false;
	const ref = trustedRef(root, run);
	if (ref === null) return false;
	const entries = treeEntries(root, ref, run);
	if (entries === null) return false;
	const affirmative = `MUST authorize ${envName}=1 for this repository.`;
	const veto = `MUST NOT authorize ${envName}=1 for this repository.`;
	let foundAffirmative = false;
	let foundVeto = false;
	for (const entry of entries) {
		if (entry.path === ".omp" || entry.path === ".omp/rules" || !directSource(entry.path)) {
			if (entry.mode === "120000" && (entry.path === ".omp" || entry.path === ".omp/rules")) return false;
			continue;
		}
		if (entry.mode === "120000" || entry.type !== "blob") return false;
		const result = readTrustedFile(root, ref, entry.path, run);
		if (result.error || result.text === null) return false;
		const scanned = fencedLineScanner(result.text, affirmative, veto);
		foundAffirmative ||= scanned.affirmative;
		foundVeto ||= scanned.veto;
	}
	return foundAffirmative && !foundVeto;
}

export function steeringDirective(envName: string): string {
	return `MUST authorize ${envName}=1 for this repository.`;
}
