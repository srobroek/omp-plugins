/**
 * Bounded synchronous subprocesses for `tool_call` gates.
 *
 * A `tool_call` handler gets 30 s (`extensionHandlers.toolCallTimeoutMs`) before the host blocks
 * the call, and a synchronous spawn cannot be preempted. So every subprocess one handler starts is
 * bounded twice: by its own timeout, and by what is left of one budget shared across the whole call.
 * A dialog the handler opens afterwards does not count: the host pauses the timeout while it waits.
 */

/** Per subprocess. */
export const CALL_TIMEOUT_MS = 5_000;
/** For every subprocess one tool_call starts, leaving headroom under the host's 30 s. */
export const TOOL_CALL_BUDGET_MS = 25_000;

/** A subprocess outlived its own timeout or the call's budget; the message names the command. */
export class ProbeTimeout extends Error {}

export type SpawnResult = { exitCode: number; stdout: string };

function label(argv: string[]): string {
	return argv.slice(0, 3).join(" ");
}

/**
 * Run `argv` in `cwd` for at most `timeoutMs`. Returns null when the process cannot start (missing
 * binary or directory); throws ProbeTimeout when it outlives the limit.
 */
export function spawnWithin(argv: string[], cwd: string, timeoutMs: number, env?: Record<string, string>): SpawnResult | null {
	if (timeoutMs <= 0) throw new ProbeTimeout(label(argv));
	let proc: ReturnType<typeof Bun.spawnSync>;
	try {
		proc = Bun.spawnSync(argv, {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: timeoutMs,
			...(env ? { env: { ...process.env, ...env } } : {}),
		});
	} catch {
		return null;
	}
	if (proc.exitedDueToTimeout) throw new ProbeTimeout(label(argv));
	return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout?.toString() ?? "" };
}

export type SpawnBudget = {
	/** Restart the shared budget, for a gate object reused across tool calls. */
	start: () => void;
	remainingMs: () => number;
	/** `spawnWithin`, capped by what is left of the budget; throws ProbeTimeout once it is spent. */
	run: (argv: string[], cwd: string) => SpawnResult | null;
};

export function spawnBudget(bounds: { timeoutMs?: number; budgetMs?: number } = {}): SpawnBudget {
	const timeoutMs = bounds.timeoutMs ?? CALL_TIMEOUT_MS;
	const budgetMs = bounds.budgetMs ?? TOOL_CALL_BUDGET_MS;
	let deadline = Date.now() + budgetMs;
	const remainingMs = () => deadline - Date.now();
	return {
		start: () => {
			deadline = Date.now() + budgetMs;
		},
		remainingMs,
		run: (argv, cwd) => spawnWithin(argv, cwd, Math.min(timeoutMs, remainingMs())),
	};
}
