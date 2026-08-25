/**
 * Refuse `bd close` on a gate bead.
 *
 * A gate's id is an ordinary bd id, so nothing in the command reveals what is
 * being closed: `issue_type: gate` is the only marker and it lives in the
 * database. `rule://beads-gate-close` therefore fires on the shapes that reveal
 * intent (a placeholder naming a gate, a reason mentioning one, a gate id piped
 * from `bd gate list`). This gate closes the remaining hole by asking the
 * database: it resolves every literal id on the command line through
 * `bd show --json` and blocks when any of them is a gate.
 *
 * Advisory-class, so it fails open. An unreachable database, a missing `bd`, a
 * command whose ids are shell variables, and `bd close` with no id at all all
 * allow the call: a guard that blocks when it cannot see is worse than the TTSR
 * rule it backs up.
 */
import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const TIMEOUT_MS = 10_000;

/** `bd` flags that consume the following token, so it is never an issue id. */
const VALUE_FLAGS = new Set([
	"--actor",
	"--db",
	"-C",
	"--directory",
	"--dolt-auto-commit",
	"-r",
	"--reason",
	"--reason-file",
	"--session",
]);

/** Flags selecting which database `bd` opens; `bd show` must be told the same. */
const DB_VALUE_FLAGS = new Set(["--db", "-C", "--directory"]);
const DB_BOOL_FLAGS = new Set(["--global"]);

/** `bd close` verbs. `done` is a documented alias. */
const CLOSE_VERBS = new Set(["close", "done"]);

const SEPARATORS = new Set([";", "&", "|", "(", ")"]);

/** `<prefix>-<suffix>` bd id, e.g. `bdp-47b` or `sk-gate-probe-7gu`. */
const BD_ID = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

/** Cheap prefilter: never spawn on a command that cannot be a bd close. */
const PREFILTER = /\bbd\b[\s\S]{0,400}?\b(?:close|done)\b/;

export type BdShowRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

let injectedRun: BdShowRun | null = null;

/** Replace the `bd show` seam. Pass `null` to restore the real one. */
export function setBdShowRunForTests(fn: BdShowRun | null): void {
	injectedRun = fn;
}

function defaultRun(argv: string[], cwd: string): { exitCode: number; stdout: string } {
	const proc = Bun.spawnSync(argv, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: TIMEOUT_MS,
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString() };
}

export function extractCommand(input: Record<string, unknown>): string {
	if (typeof input.command === "string") return input.command;
	if (typeof input.cmd === "string") return input.cmd;
	return "";
}

/**
 * Shell-ish tokenizer: enough to tell an id from a flag value and to keep a
 * quoted `bd close` inside a `--reason` from reading as a second command.
 */
export function tokenize(command: string): string[] {
	const out: string[] = [];
	let cur = "";
	let started = false;
	let quote: '"' | "'" | null = null;
	const flush = (): void => {
		if (started) {
			out.push(cur);
			cur = "";
			started = false;
		}
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote) {
			if (ch === quote) quote = null;
			else {
				cur += ch;
				started = true;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			cur += command[i + 1] as string;
			started = true;
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		if (SEPARATORS.has(ch)) {
			flush();
			out.push(ch);
			continue;
		}
		cur += ch;
		started = true;
	}
	flush();
	return out;
}

export type CloseInvocation = {
	/** Literal ids on the command line; empty when they are variables or absent. */
	ids: string[];
	/** Database selectors to replay on `bd show`. */
	dbArgs: string[];
};

/** Every `bd ... close`/`done` invocation in the command, with its ids. */
export function findCloseInvocations(command: string): CloseInvocation[] {
	const tokens = tokenize(command);
	const out: CloseInvocation[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] !== "bd") continue;
		const dbArgs: string[] = [];
		const ids: string[] = [];
		let verb: string | null = null;
		let j = i + 1;
		for (; j < tokens.length; j++) {
			const token = tokens[j] as string;
			if (SEPARATORS.has(token)) break;
			if (token.startsWith("-") && token !== "-") {
				const eq = token.indexOf("=");
				const name = eq === -1 ? token : token.slice(0, eq);
				if (DB_VALUE_FLAGS.has(name)) {
					if (eq !== -1) dbArgs.push(token);
					else {
						const value = tokens[j + 1];
						if (value !== undefined && !SEPARATORS.has(value)) {
							dbArgs.push(name, value);
							j++;
						}
					}
					continue;
				}
				if (DB_BOOL_FLAGS.has(name)) {
					dbArgs.push(name);
					continue;
				}
				if (eq === -1 && VALUE_FLAGS.has(name)) j++;
				continue;
			}
			if (verb === null) {
				verb = token.toLowerCase();
				continue;
			}
			if (BD_ID.test(token)) ids.push(token);
		}
		i = j;
		if (verb !== null && CLOSE_VERBS.has(verb)) out.push({ ids, dbArgs });
	}
	return out;
}

/**
 * Canonical ids among `ids` whose `issue_type` is `gate`.
 *
 * `bd show` takes every id in one call and silently drops the ones it cannot
 * resolve, so an unknown id costs nothing. It exits non-zero only when no id
 * resolved at all, which reads as "nothing to say" rather than "block".
 *
 * `cwd` is the directory the bash tool would have run in, because bd
 * auto-discovers `.beads/*.db` from there. An explicit `-C`/`--db` on the
 * original command is replayed in `dbArgs` and still wins, exactly as it would
 * for the `bd close` this is deciding about.
 */
export function gateIdsAmong(
	ids: string[],
	dbArgs: string[] = [],
	cwd: string = process.cwd(),
): string[] {
	if (ids.length === 0) return [];
	const run = injectedRun ?? defaultRun;
	const result = run(["bd", ...dbArgs, "show", ...ids, "--json"], cwd);
	if (result.exitCode !== 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return [];
	}
	// A failed lookup answers with an `{error}` object instead of the array.
	if (!Array.isArray(parsed)) return [];
	const gates: string[] = [];
	for (const row of parsed) {
		if (!row || typeof row !== "object") continue;
		const issue = row as { id?: unknown; issue_type?: unknown };
		if (issue.issue_type === "gate" && typeof issue.id === "string") gates.push(issue.id);
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

export function decideBdClose(
	command: string,
	cwd: string = process.cwd(),
): { block: true; reason: string } | undefined {
	if (!PREFILTER.test(command)) return;
	const invocations = findCloseInvocations(command);
	if (invocations.length === 0) return;
	const gates = new Set<string>();
	for (const invocation of invocations) {
		for (const id of gateIdsAmong(invocation.ids, invocation.dbArgs, cwd)) gates.add(id);
	}
	if (gates.size === 0) return;
	return { block: true, reason: denyReason([...gates]) };
}

export default function bdCloseGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command) return;
			const cwd =
				typeof event.input.cwd === "string" && event.input.cwd
					? event.input.cwd
					: process.cwd();
			return decideBdClose(command, cwd);
		} catch {
			return;
		}
	});
}
