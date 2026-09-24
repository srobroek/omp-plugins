/**
 * Refuse `bd close` on a gate bead.
 *
 * A gate's id is an ordinary bd id, so nothing in the command reveals what is
 * being closed: `issue_type: gate` is the only marker and it lives in the
 * database. The former advisory could only infer intent from shapes such as a placeholder
 * naming a gate, a reason mentioning one, or a gate id piped from `bd gate list`.
 * This database-aware gate closes that hole by resolving every literal id on the
 * command line through
 * `bd show --json` and blocks when any of them is a gate.
 *
 * Advisory-class, but database lookup failures fail closed at the Bash dispatcher.
 * An unreachable database, a missing `bd`, or malformed lookup output refuses the
 * close without gate proof. A command whose ids are shell variables, or `bd close`
 * with no id at all, has no lookup to perform and remains allowed.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { tokenizeShell } from "./shell-tokenizer.ts";

/** A tool_call has a 30,000 ms budget; leave 5,000 ms for all gate lookups and dispatch. */
const TIMEOUT_MS = 25_000;


/** Cheap prefilter: never spawn on a command that cannot be a bd close. */
const PREFILTER = /\bbd\b[\s\S]{0,400}?\b(?:close|done)\b/;

export type BdShowRun = (argv: string[], cwd: string, deadline?: number) => { exitCode: number; stdout: string };

let injectedRun: BdShowRun | null = null;

/** Replace the `bd show` seam. Pass `null` to restore the real one. */
export function setBdShowRunForTests(fn: BdShowRun | null): void {
	injectedRun = fn;
}

function timeoutError(): Error {
	return new Error("bd show lookup timed out; gate types remain unverified");
}

function defaultRun(argv: string[], cwd: string, deadline = Date.now() + TIMEOUT_MS): { exitCode: number; stdout: string } {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw timeoutError();
	const proc = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: Math.min(TIMEOUT_MS, remaining),
		env: { ...process.env, BD_JSON_ENVELOPE: "1", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	if (proc.exitCode === null) throw timeoutError();
	if (Date.now() >= deadline) throw timeoutError();
	return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
}

export { commandFromInput as extractCommand } from "./shell-command.ts";

/** Shared parser compatibility surfaces for existing direct unit callers. */
export function tokenize(command: string): string[] {
	return tokenizeShell(command).map(({ value }) => value);
}
export { type CloseInvocation, closeInvocations as findCloseInvocations } from "./shell-command.ts";

/**
 * Canonical ids among `ids` whose `issue_type` is `gate`.
 *
 * An unavailable or incomplete lookup is a refusal: allowing a close without
 * proving its type would make the gate safety check a silent no-op.
 *
 * `cwd` is the directory the bash tool would have run in, because bd
 * auto-discovers `.beads/*.db` from there. An explicit `-C`/`--db` on the
 * original command is replayed in `dbArgs` and still wins.
 */
export function gateIdsAmong(
	ids: string[],
	dbArgs: string[] = [],
	cwd: string = process.cwd(),
	deadline = Date.now() + TIMEOUT_MS,
): string[] {
	if (ids.length === 0) return [];
	if (Date.now() >= deadline) throw timeoutError();
	const run = injectedRun ?? defaultRun;
	const result = run(["bd", ...dbArgs, "show", ...ids, "--json"], cwd, deadline);
	if (Date.now() >= deadline) throw timeoutError();
	if (result.exitCode !== 0) throw new Error(`bd show lookup failed with exit code ${result.exitCode}; gate types remain unverified`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("bd show returned unreadable JSON; gate types remain unverified");
	}
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
		"schema_version" in parsed && "data" in parsed) parsed = parsed.data;
	if (!Array.isArray(parsed)) throw new Error("bd show returned no issue array; gate types remain unverified");
	const gates: string[] = [];
	for (const row of parsed) {
		if (!row || typeof row !== "object") throw new Error("bd show returned malformed issues; gate types remain unverified");
		const issue = row as { id?: unknown; issue_type?: unknown };
		if (typeof issue.id !== "string" || typeof issue.issue_type !== "string") {
			throw new Error("bd show omitted issue identity or type; gate types remain unverified");
		}
		if (issue.issue_type === "gate") gates.push(issue.id);
	}
	return gates;
}

export function denyReason(gateIds: string[]): string {
	return (
		`blocked by beads (a gate bead is resolved, never closed): ${gateIds.join(", ")} ` +
		"is a gate. `bd close` on it flips status to closed and does unblock the waiting " +
		"bead, so nothing fails loudly -- but no gate resolution happens. A `human` gate " +
		"loses the decision it stood for, and a `timer`/`gh:run`/`gh:pr`/`bead` gate is " +
		"asserted satisfied without anything evaluating it. Run `bd gate check` to have the " +
		"conditions evaluated, or `bd gate resolve <gate-id>` for the manual human answer; " +
		"then `bd close <step-id> --reason ...` on the step the gate blocked. `--force` does " +
		"not lift this guard: it forces the same unrecorded close."
	);
}

import { closeInvocations, type ParsedCommand } from "./shell-command.ts";

async function asyncShowRun(argv: string[], cwd: string, deadline = Date.now() + TIMEOUT_MS): Promise<{ exitCode: number; stdout: string }> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw timeoutError();
	const proc = Bun.spawn(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, BD_JSON_ENVELOPE: "1", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1" },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				proc.kill("SIGKILL");
				reject(timeoutError());
			}, remaining);
		});
		const result = await Promise.race([
			Promise.all([proc.exited, new Response(proc.stdout).text()]),
			timeout,
		]);
		if (Date.now() >= deadline) throw timeoutError();
		return { exitCode: result[0], stdout: result[1] };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function gateIdsAmongAsync(ids: string[], dbArgs: string[], cwd: string, deadline: number): Promise<string[]> {
	if (ids.length === 0) return [];
	if (Date.now() >= deadline) throw timeoutError();
	const run = injectedRun === null
		? asyncShowRun
		: async (argv: string[], dir: string, limit: number) => injectedRun?.(argv, dir, limit) ?? asyncShowRun(argv, dir, limit);
	const result = await run(["bd", ...dbArgs, "show", ...ids, "--json"], cwd, deadline);
	if (Date.now() >= deadline) throw timeoutError();
	if (result.exitCode !== 0) throw new Error(`bd show lookup failed with exit code ${result.exitCode}; gate types remain unverified`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("bd show returned unreadable JSON; gate types remain unverified");
	}
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "schema_version" in parsed && "data" in parsed) parsed = parsed.data;
	if (!Array.isArray(parsed)) throw new Error("bd show returned no issue array; gate types remain unverified");
	const gates: string[] = [];
	for (const row of parsed) {
		if (!row || typeof row !== "object") throw new Error("bd show returned malformed issues; gate types remain unverified");
		const issue = row as { id?: unknown; issue_type?: unknown };
		if (typeof issue.id !== "string" || typeof issue.issue_type !== "string") throw new Error("bd show omitted issue identity or type; gate types remain unverified");
		if (issue.issue_type === "gate") gates.push(issue.id);
	}
	return gates;
}

/** Evaluate parsed command positions recursively, using async lookups at the bash boundary. */
export async function decideBdCloseParsed(parsed: ParsedCommand, cwd = process.cwd(), deadline?: number): Promise<{ block: true; reason: string } | undefined> {
	const sharedDeadline = deadline ?? Date.now() + TIMEOUT_MS;
	for (const position of parsed.commands) {
		const invocations = closeInvocations(position.raw);
		if (invocations.length === 0) continue;
		const gates = new Set<string>();
		for (const invocation of invocations) {
			for (const id of await gateIdsAmongAsync(invocation.ids, invocation.dbArgs, cwd, sharedDeadline)) gates.add(id);
		}
		if (gates.size > 0) return { block: true, reason: denyReason([...gates]) };
	}
	for (const child of parsed.nested) {
		const decision = await decideBdCloseParsed(child, cwd, sharedDeadline);
		if (decision) return decision;
	}
	return undefined;
}

export function decideBdClose(
	command: string,
	cwd: string = process.cwd(),
	deadline?: number,
): { block: true; reason: string } | undefined {
	if (!PREFILTER.test(command)) return;
	const invocations = closeInvocations(command);
	if (invocations.length === 0) return;
	const sharedDeadline = deadline ?? Date.now() + TIMEOUT_MS;
	const gates = new Set<string>();
	for (const invocation of invocations) {
		for (const id of gateIdsAmong(invocation.ids, invocation.dbArgs, cwd, sharedDeadline)) gates.add(id);
	}
	if (gates.size === 0) return;
	return { block: true, reason: denyReason([...gates]) };
}

export default function bdCloseGate(_pi: ExtensionAPI): void {
	// Bash calls are dispatched by bash-gates.ts.
}
