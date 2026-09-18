import { spawnSync } from "node:child_process";

/** The only directive that can authorize the canonical-checkout exception. */
export const PRIMARY_CHECKOUT_DIRECTIVE =
	"MUST authorize DELIVERY_ALLOW_PRIMARY_CHECKOUT=1 for this repository.";

const TRUSTED_POLICY_PATH = /^(?:AGENTS\.md|CLAUDE\.md|\.omp\/rules\/[^/]+\.md)$/;
const LOOKUP_TIMEOUT_MS = 2_000;
const MAX_POLICY_FILES = 256;
const MAX_BLOB_BYTES = 1 << 20;
const MAX_OUTPUT_BYTES = 1 << 20;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

type GitRunner = (cwd: string, args: readonly string[], timeoutMs: number) => string | null;

let injectedGit: GitRunner | null = null;

/** Test seam for timeout, malformed-output, and cumulative-bound controls. */
export function setTrustedPrimaryPolicyGitForTests(run: GitRunner | null): void {
	injectedGit = run;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CONFIG_SYSTEM = "/dev/null";
	env.GIT_CONFIG_COUNT = "0";
	env.GIT_NO_REPLACE_OBJECTS = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

function defaultGit(cwd: string, args: readonly string[], timeoutMs: number): string | null {
	try {
		const result = spawnSync("git", ["-C", cwd, "--no-replace-objects", ...args], {
			encoding: "utf8",
			env: sanitizedEnvironment(),
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});
		if (result.error || (result.signal !== null && result.signal !== undefined) || result.status !== 0) return null;
		const stdout = typeof result.stdout === "string" ? result.stdout : null;
		return stdout !== null && Buffer.byteLength(stdout, "utf8") <= MAX_BLOB_BYTES ? stdout : null;
	} catch {
		return null;
	}
}

/** Read one bounded Git result, charging every subprocess against one lookup budget. */
function git(cwd: string, args: readonly string[], deadline: number, budget: { remaining: number }): string | null {
	const timeoutMs = deadline - Date.now();
	if (timeoutMs <= 0) return null;
	const result = (injectedGit ?? defaultGit)(cwd, args, timeoutMs);
	if (result === null) return null;
	const bytes = Buffer.byteLength(result, "utf8");
	if (bytes > budget.remaining) return null;
	budget.remaining -= bytes;
	return result;
}

/**
 * Read policy only from regular-file blobs in the committed, unreplaced
 * `HEAD^{commit}` tree. Every subprocess shares one deadline and output budget.
 */
export function trustedPrimaryPolicy(canonical: string): boolean {
	const deadline = Date.now() + LOOKUP_TIMEOUT_MS;
	const budget = { remaining: MAX_OUTPUT_BYTES };
	const head = git(canonical, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], deadline, budget)?.trim();
	if (head === undefined || !OBJECT_ID.test(head)) return false;
	const tree = git(
		canonical,
		["ls-tree", "-r", "-z", "--full-tree", head, "--", "AGENTS.md", "CLAUDE.md", ".omp/rules/*.md"],
		deadline,
		budget,
	);
	if (tree === null) return false;
	const entries = tree.split("\0").filter(Boolean);
	if (entries.length > MAX_POLICY_FILES) return false;
	for (const entry of entries) {
		const match = /^(\d+) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
		if (match === null) return false;
		const mode = match[1] as string;
		const kind = match[2] as string;
		const oid = match[3] as string;
		const file = match[4] as string;
		if (kind !== "blob" || !/^100(?:644|755)$/.test(mode)) continue;
		if (!OBJECT_ID.test(oid) || !TRUSTED_POLICY_PATH.test(file)) return false;
		const contents = git(canonical, ["cat-file", "blob", oid], deadline, budget);
		if (contents === null) return false;
		if (contents.split(/\r?\n/).some(line => line === PRIMARY_CHECKOUT_DIRECTIVE)) return true;
	}
	return false;
}
