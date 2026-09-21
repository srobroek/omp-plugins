/**
 * Which `.beads` a directory resolves.
 *
 * Its own module because two extensions need it and one of them is the write lock:
 * importing it from `session-beads-lifecycle` while that module imports the lock's
 * classifier formed a cycle, and under Bun the cycle left the classifier undefined at
 * call time, so four session-boundary tests hung or returned nothing. Nothing here
 * imports a sibling extension, which is what keeps that from coming back.
 */

import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** The git common directory for `cwd`, or explicit unknown when Git cannot answer. */
export function repoIdentity(cwd: string): string {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
		encoding: "utf8",
		timeout: 2000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.signal !== null) return undefined as unknown as string;
	if (result.status !== 0) {
		const stderr = String(result.stderr ?? "");
		// A successful no-repository diagnosis remains a definite non-repository
		// answer. Any repository metadata, missing binary, timeout, or other error
		// is unknown and must not fall back to `cwd`.
		if (/not a git repository/i.test(stderr) && repositoryState(cwd) === "absent") return cwd;
		return undefined as unknown as string;
	}
	const out = String(result.stdout ?? "").trim();
	try {
		return realpathSync(isAbsolute(out) ? out : resolve(cwd, out));
	} catch {
		return undefined as unknown as string;
	}
}

function repositoryState(cwd: string): "present" | "absent" | "unknown" {
	let current: string;
	try {
		current = realpathSync(cwd);
	} catch {
		return "unknown";
	}
	for (;;) {
		try {
			lstatSync(resolve(current, ".git"));
			return "present";
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return "unknown";
		}
		const parent = dirname(current);
		if (parent === current) return "absent";
		current = parent;
	}
}

/**
 * The database a checkout provides. Linked worktrees always use the primary
 * checkout's store, even when ignored state copied a local `.beads`.
 */
export function sessionPinFor(cwd: string): string | undefined {
	const local = resolve(cwd, ".beads");
	const common = repoIdentity(cwd);
	if (common === undefined) return undefined;
	if (common !== cwd && common.endsWith("/.git")) {
		const primaryRoot = resolve(common, "..");
		try {
			if (realpathSync(cwd) === primaryRoot && isDir(local)) return local;
		} catch {
			return undefined;
		}
		const primary = resolve(primaryRoot, ".beads");
		if (isDir(primary)) return primary;
	}
	if (isDir(local)) return local;
	return undefined;
}


function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
