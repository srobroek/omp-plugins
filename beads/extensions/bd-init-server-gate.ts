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
 * Argv is the trigger, through the same reader as `bd-init-advisory`: a mention of
 * `bd init` inside a quoted string or another program's arguments is not an
 * invocation. Only when that reader throws on text that carries the token `bd init`
 * does the gate fail closed; a command it can read and finds no invocation in is
 * allowed.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { extractCommand } from "./bd-close-gate.ts";
import { findInitInvocations, type InitInvocation } from "./bd-init-advisory.ts";

/** Cheap prefilter shared with the advisory: never tokenize a command that cannot be a `bd init`. */
const PREFILTER = /\bbd\b[\s\S]{0,400}?\binit\b/;

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
	"bd init refused: the command text carries `bd init` but could not be read as a shell command, so the gate cannot tell which store it would create. Simplify the command.";

/**
 * The refusal this command earns, or `undefined` when it may run.
 *
 * `cwd` is the bash call's working directory; an invocation's own `-C` / `--directory`
 * overrides it, because that is where `bd` will look for `.beads/metadata.json`.
 */
export function decideBdInitServer(
	command: string,
	cwd: string,
	gate: GateEnvironment = defaultGateEnvironment(),
): { block: true; reason: string } | undefined {
	if (!PREFILTER.test(command)) return undefined;
	let invocations: InitInvocation[];
	try {
		invocations = findInitInvocations(command);
	} catch {
		return { block: true, reason: PARSE_REFUSAL };
	}
	for (const invocation of invocations) {
		if (invocation.flags.some(flag => HELP_FLAGS[flag] === true)) continue;
		const serverFlag = invocation.flags.some(flag => SERVER_FLAGS[flag] === true);
		if (!serverFlag && !ENV_ON[gate.env.BEADS_DOLT_SHARED_SERVER ?? ""]) return { block: true, reason: MODE_REFUSAL };
		const dir = invocation.dir === undefined ? cwd : path.resolve(cwd, invocation.dir);
		const database = databaseFor(invocation, dir);
		const owned = ownedDatabase(dir);
		if (owned === database) continue;
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
			return decideBdInitServer(command, cwd);
		} catch (error) {
			// Fail closed only where the text names the command this gate exists for.
			if (PREFILTER.test(extractCommand(event.input))) {
				return { block: true, reason: `${PARSE_REFUSAL} (${error instanceof Error ? error.message : String(error)})` };
			}
			return;
		}
	});
}
