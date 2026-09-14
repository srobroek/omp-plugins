/**
 * Refuse a `bd init` that would create an embedded store, or collide with a database
 * the shared Dolt server already holds.
 *
 * Why a refusal and not advice: OMP's isolated subagents run in a clone of the
 * checkout, and an embedded store forks with the clone, so every claim and closure a
 * worker writes lands in a database nobody reads. The machine-wide default is the
 * shared server; a `bd init` that ignores it produces a project that is broken for
 * orchestration from its first commit.
 *
 * What satisfies the gate: `--shared-server` or `--server` on the command, or
 * `BEADS_DOLT_SHARED_SERVER` set to `true` or `1` in this process's environment, which
 * is what the spawned `bd` inherits (both spellings complete a plain init; verified
 * 2026-09-14). The user-level `~/.config/bd/config.yaml` carrier is
 * deliberately NOT accepted: on bd 1.2.2 it records server mode in `metadata.json`
 * but leaves the init half done (embedded store created, server database never
 * created), verified 2026-09-14.
 *
 * The second refusal is the prefix-overlap hazard, also verified 2026-09-14:
 * `dolt_database` defaults to the issue prefix, so two projects that share a prefix
 * silently share one database. When the database `bd init` would use already exists
 * on the shared server and this checkout does not already own it, the gate names the
 * collision and asks for a different `--prefix`.
 *
 * Argv is the trigger, through the same reader as `bd-init-advisory`: `bd` by basename,
 * behind environment prefixes, the launchers the reader knows (`env`, `sudo`, `exec`,
 * `nice`, `timeout`, `mise exec --`, ...), and a literal `sh -c '...'`; a mention of
 * `bd init` inside a quoted string or another program's arguments is not an invocation.
 * The gate fails closed when the reader reports a wrapper or `cd` it could not follow.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { extractCommand } from "./bd-close-gate.ts";
import { findInitInvocations, type InitInvocation } from "./bd-init-advisory.ts";

/** Cheap prefilter: never tokenize a command that cannot mention `bd`. */
const PREFILTER = /\bbd\b/;

/** Flags that make `bd init` create a server-mode store. */
const SERVER_FLAGS: Record<string, true> = { "--shared-server": true, "--server": true };

/** Values of `BEADS_DOLT_SHARED_SERVER` that bd 1.2.2 honours. */
const ENV_ON: Record<string, true> = { true: true, "1": true };

/** `--help` prints; it initialises nothing. */
const HELP_FLAGS: Record<string, true> = { "--help": true, "-h": true };

export interface GateEnvironment {
	env: NodeJS.ProcessEnv;
	/** `~/.beads/shared-server/dolt`, where the shared server keeps one directory per database. */
	sharedServerDataDir: string;
}

export function defaultGateEnvironment(): GateEnvironment {
	return {
		env: process.env,
		sharedServerDataDir: path.join(os.homedir(), ".beads", "shared-server", "dolt"),
	};
}

/**
 * The database name this init would create: the `--prefix` value, else the
 * directory's basename with `-` replaced by `_` (observed: `omp-orchestrate` →
 * `omp_orchestrate`).
 */
export function databaseFor(invocation: InitInvocation, cwd: string): string {
	if (invocation.prefix !== undefined && invocation.prefix.length > 0) return invocation.prefix.replace(/-/g, "_");
	return path.basename(cwd).replace(/-/g, "_");
}

/** The `dolt_database` this checkout already pins, or `undefined` when it has no `.beads/metadata.json`. */
export function ownedDatabase(cwd: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(cwd, ".beads", "metadata.json"), "utf8"));
		if (parsed !== null && typeof parsed === "object" && "dolt_database" in parsed) {
			const value = parsed.dolt_database;
			if (typeof value === "string" && value.length > 0) return value;
		}
	} catch {
		// No metadata, or unreadable: this checkout owns nothing yet.
	}
	return undefined;
}

export const MODE_REFUSAL =
	"bd init refused: this would create an embedded store, and OMP's isolated subagents fork an embedded store with every clone. " +
	"Add `--shared-server` to the command, or `export BEADS_DOLT_SHARED_SERVER=true` (or `=1`) before starting omp. " +
	"The user-level `~/.config/bd/config.yaml` default does not count: on bd 1.2.2 it records server mode but never creates the server database.";

export function collisionRefusal(database: string): string {
	return (
		`bd init refused: the shared Dolt server already holds a database named \`${database}\`, and this checkout does not own it ` +
		"(`dolt_database` defaults to the issue prefix, so two projects with one prefix silently share one database). " +
		"Pass a different `--prefix`, or run `bd bootstrap` if this checkout is a clone of the project that owns it."
	);
}

export const PARSE_REFUSAL =
	"bd init refused: the command reaches `bd init` through a wrapper or directory change this gate cannot follow (`env -S`, `mise` without `--`, `cd -`, a `$variable`), so it cannot tell which store it would create or where. Run `bd init --shared-server ...` directly.";

/**
 * The environment the spawned `bd` will see: the process environment, then the bash
 * call's structured `env`, then what the command line itself sets or clears.
 */
function effectiveEnv(
	processEnv: NodeJS.ProcessEnv,
	inputEnv: Record<string, unknown> | undefined,
	invocation: InitInvocation,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = invocation.cleared ? {} : { ...processEnv };
	if (inputEnv !== undefined && !invocation.cleared) {
		for (const [key, value] of Object.entries(inputEnv)) if (typeof value === "string") env[key] = value;
	}
	for (const [key, value] of Object.entries(invocation.env)) env[key] = value;
	return env;
}

/**
 * The refusal this command earns, or `undefined` when it may run.
 *
 * `cwd` is the bash call's working directory; a `cd` before `bd`, `env -C`, `sudo -D`,
 * and `bd`'s own `-C` / `--directory` move it, because that is where `bd` looks for
 * `.beads/metadata.json`. `inputEnv` is the bash call's structured `env`.
 */
export function decideBdInitServer(
	command: string,
	cwd: string,
	gate: GateEnvironment = defaultGateEnvironment(),
	inputEnv: Record<string, unknown> | undefined = undefined,
): { block: true; reason: string } | undefined {
	if (!PREFILTER.test(command)) return undefined;
	let invocations: InitInvocation[];
	try {
		invocations = findInitInvocations(command, cwd);
	} catch {
		return { block: true, reason: PARSE_REFUSAL };
	}
	for (const invocation of invocations) {
		if (invocation.flags.some(flag => HELP_FLAGS[flag] === true)) continue;
		if (invocation.unresolved) return { block: true, reason: PARSE_REFUSAL };
		const serverFlag = invocation.flags.some(flag => SERVER_FLAGS[flag] === true);
		const env = effectiveEnv(gate.env, inputEnv, invocation);
		if (!serverFlag && !ENV_ON[env.BEADS_DOLT_SHARED_SERVER ?? ""]) return { block: true, reason: MODE_REFUSAL };
		const shellCwd = invocation.cwd;
		if (shellCwd === undefined) return { block: true, reason: PARSE_REFUSAL };
		const dir = invocation.dir === undefined ? shellCwd : path.resolve(shellCwd, invocation.dir);
		const database = databaseFor(invocation, dir);
		if (ownedDatabase(dir) === database) continue;
		if (existsSync(path.join(gate.sharedServerDataDir, database))) return { block: true, reason: collisionRefusal(database) };
	}
	return undefined;
}

export default function bdInitServerGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (!command) return;
			const cwd =
				"cwd" in event.input && typeof event.input.cwd === "string" && event.input.cwd ? event.input.cwd : process.cwd();
			const inputEnv =
				"env" in event.input && event.input.env !== null && typeof event.input.env === "object" && !Array.isArray(event.input.env)
					? (event.input.env as Record<string, unknown>)
					: undefined;
			return decideBdInitServer(command, cwd, defaultGateEnvironment(), inputEnv);
		} catch (error) {
			// Fail closed only where the text names the command this gate exists for.
			if (PREFILTER.test(extractCommand(event.input))) {
				return { block: true, reason: `${PARSE_REFUSAL} (${error instanceof Error ? error.message : String(error)})` };
			}
			return;
		}
	});
}
