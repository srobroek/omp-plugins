/**
 * Which `.beads` a directory resolves.
 *
 * Its own module because two extensions need it and one of them is the write lock:
 * importing it from `session-beads-lifecycle` while that module imports the lock's
 * classifier formed a cycle, and under Bun the cycle left the classifier undefined at
 * call time, so four session-boundary tests hung or returned nothing. Nothing here
 * imports a sibling extension, which is what keeps that from coming back.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** The git common directory for `cwd`, or `cwd` when it is not in a repository. */
export function repoIdentity(cwd: string): string {
	try {
		const out = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return realpathSync(isAbsolute(out) ? out : resolve(cwd, out));
	} catch {
		return cwd;
	}
}

/**
 * The database a checkout provides. Linked worktrees always use the primary
 * checkout's store, even when ignored state copied a local `.beads`.
 */
export function sessionPinFor(cwd: string): string | undefined {
	const local = resolve(cwd, ".beads");
	const common = repoIdentity(cwd);
	if (common !== cwd && common.endsWith("/.git")) {
		const primaryRoot = resolve(common, "..");
		if (realpathSync(cwd) === primaryRoot && isDir(local)) return local;
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
