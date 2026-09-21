/**
 * Tell an agent when the checkout it started in is the canonical checkout and
 * that checkout has fallen behind its upstream.
 *
 * Canonical is refreshed with `git fetch` after a pull request lands, so its
 * working tree can remain behind `origin/main` without being dirty. Reading a
 * file there then reads an older history than the project currently has.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { insideAny, type RepositoryTopology, repositoryTopology } from "./worktree-gate.ts";

/** Keep the one advisory probe comfortably inside the session-start budget. */
export const PROBE_TIMEOUT_MS = 2_000;

export type ProbeResult = {
	exitCode: number | null;
	stdout: string;
	signal?: string | null;
};

export type ProbeRunner = (cwd: string) => ProbeResult;
export type BehindProbe = (cwd: string) => number | null | PromiseLike<number | null>;
export type TopologyReader = (cwd: string) => RepositoryTopology;

/** Timer methods supplied by the session context; unknown keeps this seam host-version agnostic. */
export type TimerAPI = {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
};

/**
 * Run the direct question, with an argv and an explicit timeout. A non-zero
 * result is deliberately not interpreted as zero: detached HEAD, no upstream,
 * no remote, and an unreadable repository all make `rev-list` fail alike.
 */
export const runBehindProbe: ProbeRunner = (cwd: string): ProbeResult => {
	try {
		const proc = Bun.spawnSync(["git", "rev-list", "--count", "HEAD..@{upstream}"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: PROBE_TIMEOUT_MS,
		});
		return {
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			signal: proc.signal,
		};
	} catch {
		return { exitCode: null, stdout: "", signal: "probe-error" };
	}
};

/** Parse only a successful, exact decimal count; malformed output is unknown. */
export function commitsBehind(cwd: string, run: ProbeRunner = runBehindProbe): number | null {
	let result: ProbeResult;
	try {
		result = run(cwd);
	} catch {
		return null;
	}
	if (result.exitCode !== 0 || result.signal !== undefined && result.signal !== null) return null;
	const output = result.stdout.trim();
	if (!/^(?:0|[1-9]\d*)$/.test(output)) return null;
	const count = Number(output);
	return Number.isSafeInteger(count) ? count : null;
}

/** A one-line instruction that gives the agent both the fact and the remedy. */
export function formatCanonicalStaleAdvisory(canonical: string, behind: number): string {
	const commits = behind === 1 ? "commit" : "commits";
	return `Canonical checkout ${canonical} is ${behind} ${commits} behind its upstream; reading files there reads history, so read a worktree of origin/main instead.`;
}

export type CanonicalStaleAdvisory = { continue: true; additionalContext: string };

/**
 * This fallback is used only by the pure helper when no session context exists.
 * Its callback only resolves a promise and cannot throw; the live extension
 * always passes `ctx`, whose timer is cancelled with the session lifecycle.
 */
const fallbackTimers: TimerAPI = {
	setTimeout(callback, delayMs) {
		return globalThis.setTimeout(callback, delayMs);
	},
	clearTimer(timer) {
		globalThis.clearTimeout(timer as never);
	},
};

async function boundedProbe(cwd: string, probe: BehindProbe, timers: TimerAPI): Promise<number | null> {
	const { promise: timeout, resolve } = Promise.withResolvers<null>();
	const timer = timers.setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
	try {
		return await Promise.race([
			Promise.resolve().then(() => probe(cwd)),
			timeout,
		]);
	} catch {
		return null;
	} finally {
		timers.clearTimer(timer);
	}
}

/**
 * Assess only the session's own repository. Looking through every checkout
 * costs more probes and produces an ambiguous instruction; the agent can only
 * act on the project it started in. `repositoryTopology` is the shared helper
 * that identifies its canonical root and registered linked worktrees.
 *
 * The topology helper bounds each Git subprocess at five seconds (and can ask
 * at most two extra topology questions for unusual layouts); this advisory's
 * probe is bounded at two seconds. Thus even the slowest normal path remains
 * under the 30-second session-start budget with margin, and uncertainty stays
 * silent rather than becoming a false count.
 */
export async function handleSessionStart(
	cwd: string,
	probe: BehindProbe = commitsBehind,
	readTopology: TopologyReader = repositoryTopology,
	timers: TimerAPI = fallbackTimers,
): Promise<CanonicalStaleAdvisory | undefined> {
	try {
		const topology = readTopology(cwd);
		const canonical = topology.canonical;
		if (canonical === null) return;

		// A linked worktree is the intended place to read. Accessing `worktrees`
		// performs the shared, identity-checked lookup; a failed lookup is unknown.
		const worktrees = topology.worktrees;
		if (topology.uncertainty !== undefined && topology.uncertainty !== null) return;
		if (!insideAny(cwd, [canonical]) || insideAny(cwd, worktrees)) return;

		const behind = await boundedProbe(canonical, probe, timers);
		if (behind === null || behind === 0) return;
		return { continue: true, additionalContext: formatCanonicalStaleAdvisory(canonical, behind) };
	} catch {
		// This is an advisory, never a gate: an unreadable topology or probe is silence.
		return;
	}
}

export default function canonicalStaleAdvisory(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		try {
			const timers = typeof ctx?.setTimeout === "function" && typeof ctx?.clearTimer === "function"
				? (ctx as unknown as TimerAPI)
				: fallbackTimers;
			const advisory = await handleSessionStart(ctx?.cwd ?? process.cwd(), commitsBehind, repositoryTopology, timers);
			if (advisory === undefined) return;
			pi.sendMessage(
				{
					customType: "com.srobroek.worktrunk.canonical-stale-advisory",
					content: advisory.additionalContext,
					display: true,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
		} catch {
			// A lifecycle advisory must never make session start fail.
		}
	});
}
