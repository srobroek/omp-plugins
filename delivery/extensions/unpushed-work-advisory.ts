import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 2000;

let lastFired = false;

export function resetUnpushedAdvisoryForTests(): void {
	lastFired = false;
}

export function hasGitDir(cwd: string): boolean {
	try {
		return existsSync(join(cwd, ".git"));
	} catch {
		return false;
	}
}

export type PorcelainStatus = {
	branch: string;
	ahead: number;
	behind: number;
	dirtyTracked: number;
	untracked: number;
};

export function parsePorcelain(out: string): PorcelainStatus {
	const lines = out.split(/\r?\n/);
	let branch = "HEAD";
	let ahead = 0;
	let behind = 0;
	let dirtyTracked = 0;
	let untracked = 0;

	for (const line of lines) {
		if (!line) continue;
		if (line.startsWith("## ")) {
			const rest = line.slice(3);
			const aheadM = rest.match(/ahead (\d+)/);
			const behindM = rest.match(/behind (\d+)/);
			if (aheadM) ahead = Number(aheadM[1]);
			if (behindM) behind = Number(behindM[1]);
			const name = rest.split("...")[0]?.trim() ?? rest;
			if (name && name !== "") branch = name.replace(/\s+\[.*$/, "");
			continue;
		}
		if (line.startsWith("??")) {
			untracked += 1;
			continue;
		}
		if (line.length >= 2) {
			const xy = line.slice(0, 2);
			if (xy !== "  ") dirtyTracked += 1;
		}
	}

	return { branch, ahead, behind, dirtyTracked, untracked };
}

export function shouldAdvise(status: PorcelainStatus): boolean {
	return status.ahead > 0 || status.dirtyTracked > 0;
}

export function formatAdvisory(status: PorcelainStatus): string {
	const bits: string[] = [];
	if (status.ahead > 0) bits.push(`${status.ahead} unpushed commit(s)`);
	if (status.dirtyTracked > 0) bits.push(`${status.dirtyTracked} dirty tracked file(s)`);
	return (
		`Unpushed work on branch ${status.branch}: ${bits.join(" and ")}. ` +
		`delivery-cadence requires push-before-stop so work is not left only in a local or disposable worktree.`
	);
}

export function gitStatusPorcelain(cwd: string): string | null {
	try {
		const proc = Bun.spawnSync(["git", "status", "--porcelain", "-b"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return null;
		return proc.stdout.toString();
	} catch {
		return null;
	}
}

type SessionStopEvent = {
	stop_hook_active?: boolean;
	stopHookActive?: boolean;
};

export function handleSessionStop(
	event: SessionStopEvent,
	cwd: string,
	statusText: string | null,
): { continue: true; additionalContext: string } | undefined {
	if (event.stop_hook_active === true || event.stopHookActive === true) return;
	if (lastFired) return;
	if (!statusText) return;
	const status = parsePorcelain(statusText);
	if (!shouldAdvise(status)) return;
	lastFired = true;
	return { continue: true, additionalContext: formatAdvisory(status) };
}

export default function unpushedWorkAdvisory(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		lastFired = false;
	});
	pi.on("turn_start", () => {
		lastFired = false;
	});
	pi.on("session_stop", (event: SessionStopEvent, ctx: { cwd?: string }) => {
		try {
			const cwd = ctx?.cwd || process.cwd();
			if (!hasGitDir(cwd)) return;
			const text = gitStatusPorcelain(cwd);
			return handleSessionStop(event, cwd, text);
		} catch {
			return;
		}
	});
}
