import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 1800;
export const DEFAULT_INTERVAL_S = 20;
const BD_READY_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export type PoolWaitParams = {
	pool: string;
	epic_id: string;
	timeout_s?: number;
	interval_s?: number;
};

export type BdReadyResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
};

type WaitDependencies = {
	runReady: (pool: string, cwd: string, timeoutMs: number) => Promise<BdReadyResult>;
	sleep: (milliseconds: number) => Promise<void>;
	now: () => number;
};

type PoolWaitDetails = {
	status: "ready" | "timeout" | "error";
	pool: string;
	epic_id: string;
	timeout_s: number;
	interval_s: number;
	polls: number;
	record?: JsonRecord;
	error?: string;
};

export type PoolWaitResult = {
	content: Array<{ type: "text"; text: string }>;
	details: PoolWaitDetails;
};


async function runBdReady(pool: string, cwd: string, timeoutMs: number): Promise<BdReadyResult> {
	let process: Bun.Subprocess;
	try {
		process = Bun.spawn(["bd", "ready", "--assignee", pool, "--json"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const outcome = await Promise.race([
		process.exited.then((exitCode: number) => ({ timedOut: false as const, exitCode })),
		Bun.sleep(timeoutMs).then(() => ({ timedOut: true as const, exitCode: null })),
	]);
	if (outcome.timedOut) {
		process.kill();
		return {
			exitCode: null,
			stdout: "",
			stderr: "",
			error: `bd ready timed out after ${timeoutMs}ms`,
		};
	}
	const stdout = await new Response(process.stdout).text();
	const stderr = await new Response(process.stderr).text();
	return { exitCode: outcome.exitCode, stdout, stderr };
}
function textResult(text: string, details: PoolWaitDetails): PoolWaitResult {
	return { content: [{ type: "text", text }], details };
}

function invalidParams(message: string): PoolWaitResult {
	return textResult(`pool_wait error: ${message}`, {
		status: "error",
		pool: "",
		epic_id: "",
		timeout_s: DEFAULT_TIMEOUT_S,
		interval_s: DEFAULT_INTERVAL_S,
		polls: 0,
		error: message,
	});
}

function parseParams(params: PoolWaitParams):
	| { pool: string; epicId: string; timeoutS: number; intervalS: number }
	| { error: string } {
	if (typeof params?.pool !== "string" || params.pool.trim() === "") return { error: "pool must be a non-empty string" };
	if (typeof params?.epic_id !== "string" || params.epic_id.trim() === "") {
		return { error: "epic_id must be a non-empty string" };
	}
	const timeoutS = params.timeout_s ?? DEFAULT_TIMEOUT_S;
	if (typeof timeoutS !== "number" || !Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > MAX_TIMEOUT_S) {
		return { error: `timeout_s must be greater than 0 and at most ${MAX_TIMEOUT_S}` };
	}
	const intervalS = params.interval_s ?? DEFAULT_INTERVAL_S;
	if (typeof intervalS !== "number" || !Number.isFinite(intervalS) || intervalS <= 0) {
		return { error: "interval_s must be greater than 0" };
	}
	return { pool: params.pool.trim(), epicId: params.epic_id.trim(), timeoutS, intervalS };
}

function parseReadyRecords(stdout: string): JsonRecord[] | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		return { error: `bd ready returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!Array.isArray(parsed) || parsed.some((record) => record === null || typeof record !== "object" || Array.isArray(record))) {
		return { error: "bd ready returned a non-record JSON result" };
	}
	return parsed as JsonRecord[];
}

export async function waitForPool(
	params: PoolWaitParams,
	cwd: string,
	dependencies: Partial<WaitDependencies> = {},
): Promise<PoolWaitResult> {
	const parsed = parseParams(params);
	if ("error" in parsed) return invalidParams(parsed.error);
	const runReady = dependencies.runReady ?? runBdReady;
	const sleep = dependencies.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds));
	const now = dependencies.now ?? Date.now;
	const deadline = now() + parsed.timeoutS * 1000;
	let polls = 0;

	while (now() < deadline) {
		polls += 1;
		const result = await runReady(parsed.pool, cwd, BD_READY_TIMEOUT_MS);
		if (result.error || result.exitCode !== 0) {
			const detail = result.error ?? (result.stderr.trim() || `exit code ${result.exitCode}`);
			return textResult(`pool_wait failed: ${detail}`, {
				status: "error",
				pool: parsed.pool,
				epic_id: parsed.epicId,
				timeout_s: parsed.timeoutS,
				interval_s: parsed.intervalS,
				polls,
				error: detail,
			});
		}
		const records = parseReadyRecords(result.stdout);
		if ("error" in records) {
			return textResult(`pool_wait failed: ${records.error}`, {
				status: "error",
				pool: parsed.pool,
				epic_id: parsed.epicId,
				timeout_s: parsed.timeoutS,
				interval_s: parsed.intervalS,
				polls,
				error: records.error,
			});
		}
		const record = records.find((candidate) => {
			const metadata = candidate.metadata;
			return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) && (metadata as JsonRecord).epic_id === parsed.epicId;
		});
		if (record) {
			return textResult(JSON.stringify(record), {
				status: "ready",
				pool: parsed.pool,
				epic_id: parsed.epicId,
				timeout_s: parsed.timeoutS,
				interval_s: parsed.intervalS,
				polls,
				record,
			});
		}
		const remaining = deadline - now();
		if (remaining <= 0) break;
		await sleep(Math.min(parsed.intervalS * 1000, remaining));
	}

	return textResult(`pool_wait timed out after ${parsed.timeoutS}s`, {
		status: "timeout",
		pool: parsed.pool,
		epic_id: parsed.epicId,
		timeout_s: parsed.timeoutS,
		interval_s: parsed.intervalS,
		polls,
	});
}

export default function poolWaitTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "pool_wait",
		label: "Pool Wait",
		description: "Wait in-process for a ready Beads record in one role pool and epic without consuming a model turn.",
		parameters: z.object({
			pool: z.string().describe("Exact role pool alias, for example pool:implementer"),
			epic_id: z.string().describe("Lead-owned epic id used to filter ready records"),
			timeout_s: z.number().optional().describe(`Maximum wait in seconds, default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}`),
			interval_s: z.number().optional().describe(`Polling interval in seconds, default ${DEFAULT_INTERVAL_S}`),
		}) as unknown as TSchema,
		approval: "read",
		async execute(_id, params: PoolWaitParams, _signal, _onUpdate, ctx) {
			return waitForPool(params, ctx.cwd);
		},
	});
}
