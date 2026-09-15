import { isAbsolute, resolve } from "node:path";

export type GitRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

type TreeEntry = { mode: string; type: string; object: string; path: string };
type ReadResult = { text: string | null; error: boolean };
type RemoteDefault = { ref: string; sha: string };

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

function trustedRemoteDefault(root: string, run: GitRun): RemoteDefault | null {
	try {
		const result = run(["git", "ls-remote", "--symref", "origin", "HEAD"], root);
		if (result.exitCode !== 0) return null;
		const raw = result.stdout.replace(/\r?\n$/, "");
		const lines = raw.split(/\r?\n/);
		if (lines.length !== 2) return null;
		const symbolic = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)[ \t]+HEAD$/.exec(lines[0] ?? "");
		const resolved = /^([0-9a-f]{40}|[0-9a-f]{64})[ \t]+HEAD$/.exec(lines[1] ?? "");
		if (!symbolic || !resolved) return null;
		const ref = symbolic[1] as string;
		const sha = resolved[1] as string;
		const verified = run(["git", "rev-parse", "--verify", "--quiet", `${sha}^{commit}`], root);
		if (
			verified.exitCode !== 0 ||
			verified.stdout.trim() !== sha ||
			!/^(?:[0-9a-f]{40}|[0-9a-f]{64})\n?$/.test(verified.stdout)
		)
			return null;
		return { ref, sha };
	} catch {
		return null;
	}
}
const TREE_CACHE = new Map<string, TreeEntry[] | null>();

function treeEntries(root: string, sha: string, run: GitRun): TreeEntry[] | null {
	const cacheKey = `${root}\0${sha}`;
	if (TREE_CACHE.has(cacheKey)) return TREE_CACHE.get(cacheKey) ?? null;
	const cache = (value: TreeEntry[] | null): TreeEntry[] | null => {
		TREE_CACHE.set(cacheKey, value);
		return value;
	};
	try {
		const result = run(
			["git", "ls-tree", "-rz", "--full-tree", "-r", sha, "--", "AGENTS.md", "CLAUDE.md", ".omp"],
			root,
		);
		if (result.exitCode !== 0) return cache(null);
		const entries: TreeEntry[] = [];
		const seen = new Set<string>();
		for (const record of result.stdout.split("\0")) {
			if (!record) continue;
			const tab = record.indexOf("\t");
			if (tab < 0) return cache(null);
			const fields = record.slice(0, tab).split(" ");
			const [mode, type, object] = fields;
			const path = record.slice(tab + 1);
			if (!mode || !type || !object || fields.length !== 3 || !path || seen.has(path)) return cache(null);
			if (!/^[0-9]+$/.test(mode) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object)) return cache(null);
			seen.add(path);
			entries.push({ mode, type, object, path });
		}
		return cache(entries);
	} catch {
		return cache(null);
	}
}

function directSource(path: string): boolean {
	return (
		path === "AGENTS.md" ||
		path === "CLAUDE.md" ||
		(path.startsWith(".omp/rules/") &&
			path.endsWith(".md") &&
			!path.slice(".omp/rules/".length).includes("/"))
	);
}
const FILE_CACHE = new Map<string, ReadResult>();

function readTrustedFile(root: string, sha: string, path: string, run: GitRun): ReadResult {
	const cacheKey = `${root}\0${sha}\0${path}`;
	const cached = FILE_CACHE.get(cacheKey);
	if (cached !== undefined) return cached;
	let result: ReadResult;
	try {
		const command = run(["git", "show", `${sha}:${path}`], root);
		result = command.exitCode !== 0 ? { text: null, error: true } : { text: command.stdout, error: false };
	} catch {
		result = { text: null, error: true };
	}
	FILE_CACHE.set(cacheKey, result);
	return result;
}

function fencedLineScanner(
	text: string,
	affirmative: string,
	veto: string,
): { affirmative: boolean; veto: boolean } {
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
 * Return whether the target repository's remote-authoritative default tree authorizes an override.
 * The remote's HEAD ref and SHA come from `git ls-remote --symref origin HEAD`; mutable local
 * origin refs are never used. Only exact standalone directives in regular, non-symlink candidate
 * blobs count. Missing, malformed, ambiguous, unavailable, or mismatched data denies.
 */
const AUTH_CACHE = new Map<string, boolean>();

export function targetRepoAuthorizes(target: string, envName: string, run: GitRun): boolean {
	const root = canonicalRoot(target, run);
	if (root === null) return false;
	const remote = trustedRemoteDefault(root, run);
	if (remote === null) return false;
	const cacheKey = `${root}\0${remote.sha}\0${envName}`;
	const cached = AUTH_CACHE.get(cacheKey);
	if (cached !== undefined) return cached;
	const entries = treeEntries(root, remote.sha, run);
	if (entries === null) {
		AUTH_CACHE.set(cacheKey, false);
		return false;
	}
	const affirmative = `MUST authorize ${envName}=1 for this repository.`;
	const veto = `MUST NOT authorize ${envName}=1 for this repository.`;
	let foundAffirmative = false;
	let foundVeto = false;
	for (const entry of entries) {
		if (entry.path === ".omp" || entry.path === ".omp/rules" || !directSource(entry.path)) continue;
		if (!(entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"))) continue;
		const result = readTrustedFile(root, remote.sha, entry.path, run);
		if (result.error || result.text === null) {
			AUTH_CACHE.set(cacheKey, false);
			return false;
		}
		const scanned = fencedLineScanner(result.text, affirmative, veto);
		foundAffirmative ||= scanned.affirmative;
		foundVeto ||= scanned.veto;
	}
	const authorized = foundAffirmative && !foundVeto;
	AUTH_CACHE.set(cacheKey, authorized);
	return authorized;
}

export function steeringDirective(envName: string): string {
	return `MUST authorize ${envName}=1 for this repository.`;
}
