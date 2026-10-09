import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command, StartOptions, StartResult } from "./spec-start.ts";
import { payload, startSpec } from "./spec-start.ts";

type Held<T> = { kind: "done"; value: T } | { kind: "failed"; reason: string };
interface LockModule {
	embeddedStoreFor(cwd: string, env: NodeJS.ProcessEnv): string | undefined;
	withEmbeddedWriteLock<T>(cwd: string, owner: string, write: () => Promise<T>, env: NodeJS.ProcessEnv, deadline?: number, signal?: AbortSignal): Promise<Held<T>>;
}
export interface RuntimeOptions extends StartOptions { beadsPlugin?: string; }
/**
 * Each bounded `bd` command gets its own bound, sized for a cold embedded store, where one
 * read alone can take 30-50 s; it matches the Beads runner's bound for one-bead writes.
 * `mol pour` and `gate resolve` get no timer, because killing them partway leaves a
 * half-built run; only the caller's abort signal stops them.
 */
export const COMMAND_MS = 120_000;
const UNBOUNDED = new Set(["mol pour", "gate resolve"]);
/** How long a stopped `bd` gets after SIGTERM before SIGKILL, as the Beads runner allows. */
const TERMINATION_GRACE_MS = 5_000;
export interface IncompleteDetails { status: "INCOMPLETE"; step: string; elapsedMs: number; completedSteps: string[]; root?: string; }
/** A start stopped by its store-lock wait, a command bound, or cancellation: never a half-done success. */
export class IncompleteStart extends Error {
	constructor(message: string, readonly details: IncompleteDetails) {
		super(message);
		this.name = "IncompleteStart";
	}
}
async function lockModule(plugin?: string): Promise<LockModule> {
	let specifier = "@srobroek/beads/embedded-write";
	if (plugin) {
		const root = realpathSync(resolve(plugin));
		const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "@srobroek/beads" || !("exports" in manifest) || !manifest.exports || typeof manifest.exports !== "object" || !("./embedded-write" in manifest.exports) || manifest.exports["./embedded-write"] !== "./dist/bd-embedded-write-lock.js") throw new Error("Selected package is not the matching Beads embedded-write provider");
		specifier = pathToFileURL(join(root, "dist", "bd-embedded-write-lock.js")).href;
	}
	let imported: unknown;
	// The installed plugin is runtime-selected; its locator must retain its own import.meta.dir.
	try { imported = await import(specifier); }
	catch { throw new Error("Beads embedded-write runtime unavailable. Install the matching beads plugin or provide its package directory with beadsPlugin / --beads-plugin; no ledger writes were attempted."); }
	if (!imported || typeof imported !== "object" || !("embeddedStoreFor" in imported) || typeof imported.embeddedStoreFor !== "function" || !("withEmbeddedWriteLock" in imported) || typeof imported.withEmbeddedWriteLock !== "function") throw new Error("Beads plugin does not export the embedded-write runtime");
	return imported as LockModule;
}
export async function runSpecStart(options: RuntimeOptions, signal?: AbortSignal, commandMs = COMMAND_MS): Promise<StartResult> {
	const started = Date.now();
	const cwd = realpathSync(options.workspace);
	const env: NodeJS.ProcessEnv = { ...process.env, BEADS_DIR: realpathSync(join(cwd, ".beads")), GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS: "/usr/bin/false", SSH_ASKPASS_REQUIRE: "force", PAGER: "cat", GIT_PAGER: "cat", BD_NON_INTERACTIVE: "1", BD_NO_PAGER: "1" };
	delete env.BEADS_DOLT_SHARED_SERVER;
	const module = await lockModule(options.beadsPlugin);
	if (!module.embeddedStoreFor(cwd, env)) throw new Error("Canonical embedded store unavailable; no unserialised bd mutation is allowed");
	const completedSteps: string[] = [];
	let root = options.root;
	const incomplete = (step: string, why: string): IncompleteStart => {
		const details: IncompleteDetails = { status: "INCOMPLETE", step, elapsedMs: Date.now() - started, completedSteps: [...completedSteps], ...(root === undefined ? {} : { root }) };
		if (!completedSteps.length && why === "cancelled before") return new IncompleteStart(`Workflow start cancelled before \`${step}\`. No workflow-start command ran.`, details);
		const pour = completedSteps.includes("mol pour") ? `the pour completed${root === undefined ? "" : ` (root ${root})`}` : step === "mol pour" ? "a pour was issued and may be partial" : "no pour was issued";
		const ran = completedSteps.length ? `Completed: ${completedSteps.join(", ")}` : "No earlier command completed";
		return new IncompleteStart(`Workflow start incomplete: ${why} \`${step}\`. ${ran}; ${pour}. Inspect the run before retrying.`, details);
	};
	const command: Command = args => {
		const step = args[0] === "mol" || args[0] === "gate" ? `${args[0]} ${args[1]}` : String(args[0]);
		if (signal?.aborted) return Promise.reject(incomplete(step, "cancelled before"));
		const { promise, resolve: resolveResult, reject } = Promise.withResolvers<unknown>();
		const child = spawn("bd", [...args, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stopped: string | undefined;
		let grace: ReturnType<typeof setTimeout> | undefined;
		// The runtime is shared with the CLI, so no handler ctx timers exist here: the raw
		// timers below only ever call kill, which is wrapped because a throw from a timer
		// callback would surface as an uncaughtException in the session.
		const kill = (name: NodeJS.Signals): void => {
			try { child.kill(name); } catch { /* bd already exited; its close event settles the call. */ }
		};
		const stop = (why: string): void => {
			if (stopped !== undefined) return;
			stopped = why;
			kill("SIGTERM");
			grace = setTimeout(() => kill("SIGKILL"), TERMINATION_GRACE_MS);
		};
		const bound = UNBOUNDED.has(step) ? undefined : setTimeout(() => stop(`${commandMs / 1000} s bound reached during`), commandMs);
		const cancel = (): void => stop("cancelled during");
		signal?.addEventListener("abort", cancel, { once: true });
		const settle = (): void => {
			clearTimeout(bound);
			clearTimeout(grace);
			signal?.removeEventListener("abort", cancel);
		};
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", bytes => { stdout += bytes.toString(); });
		child.stderr.on("data", bytes => { stderr += bytes.toString(); });
		child.on("error", error => { settle(); reject(error); });
		// Settled only once bd has exited, so the store lock is never handed on while it still writes.
		child.on("close", code => {
			settle();
			if (stopped !== undefined) { reject(incomplete(step, stopped)); return; }
			if (code !== 0) { reject(new Error(stderr.trim() || `Beads command exited ${code}; inspect the run before retrying`)); return; }
			completedSteps.push(step);
			if (args[0] !== "query" && args[0] !== "show" && args[0] !== "mol") { resolveResult(undefined); return; }
			let value: unknown;
			try { value = JSON.parse(stdout); } catch { reject(new Error("Beads returned invalid JSON; inspect the run before retrying")); return; }
			const poured = step === "mol pour" ? payload(value) : undefined;
			if (poured && typeof poured === "object" && "new_epic_id" in poured && typeof poured.new_epic_id === "string") root = poured.new_epic_id;
			resolveResult(value);
		});
		return promise;
	};
	// One hold of the store's write lock spans lookup, pour, and metadata writes, so a
	// concurrent start for this workspace waits and then finds the root this one created.
	// The wait uses the Beads default bound; the signal abandons it.
	const owner = `speckit-start/${options.spec}/${randomUUID()}`;
	const held = await module.withEmbeddedWriteLock(cwd, owner, () => startSpec(options, command), env, undefined, signal);
	if (held.kind === "failed") throw new IncompleteStart(`${held.reason} No workflow-start command ran.`, { status: "INCOMPLETE", step: "store lock", elapsedMs: Date.now() - started, completedSteps: [] });
	return held.value;
}
