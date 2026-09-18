/**
 * Dolt server lifecycle for beads repositories.
 *
 * Two jobs, both session-scoped, because beads' own session hooks are Claude and
 * Codex JSON wiring that never fires under omp.
 *
 * At session start, report once when a beads repository is on the embedded backend,
 * carrying the migration route to the shared Dolt server. Embedded resolves a PATH, so
 * a copied checkout or a clone gets its own database, and the machine-wide
 * shared-server default makes every `bd` command in such a project fail.
 *
 * At session end, optionally stop a per-project server. Stopping is safe -- bd
 * flushes the working set first and the next read auto-starts a fresh process -- but
 * it stays opt-in, because a second session in the same repository would pay a
 * restart it did not ask for. The shared server is never stopped: it reports success
 * while continuing to run, since other projects may hold it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { extractCommand } from "./bd-close-gate.ts";
import { sessionPinFor } from "./beads-store.ts";
import { commandSegments, invocation } from "./shell-command.ts";

/** Where beads records the backend it resolved. */
export interface DoltMetadata {
	dolt_mode?: string;
	dolt_database?: string;
}

/** How a beads repository stores its database, as far as this extension can tell. */
export type Backend = "embedded" | "per-project" | "shared" | "unknown";

/** Opt in to stopping this project's server when the session ends. */
const STOP_ON_EXIT = "BEADS_STOP_SERVER_ON_EXIT";

/**
 * Classify the backend from the two carriers beads actually writes.
 *
 * `bd init --shared-server` writes `dolt.shared-server: true` into `config.yaml`
 * AND `dolt_mode: "server"` into `metadata.json`; plain `bd init --server` writes
 * only the metadata field. Reading one carrier alone therefore misreads one of the
 * two server layouts, and the config key is flat rather than nested under `dolt:`.
 */
export function classifyBackend(metadata: string, config: string): Backend {
	const shared = /^[^#\n]*\bshared-server:\s*true/m.test(config);
	let mode: string | undefined;
	try {
		const parsed: unknown = JSON.parse(metadata);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"dolt_mode" in parsed
		) {
			const value = (parsed as DoltMetadata).dolt_mode;
			if (typeof value === "string") mode = value;
		}
	} catch {
		// Absent or malformed metadata proves nothing; fall through to the config key.
	}

	if (shared) return "shared";
	if (mode === "server") return "per-project";
	if (mode === "embedded") return "embedded";
	return "unknown";
}

/** Classify the store held in `beads`, a resolved `.beads` directory. */
async function backendAt(beads: string): Promise<Backend> {
	const [metadata, config] = await Promise.all([
		fs.readFile(path.join(beads, "metadata.json"), "utf8").catch(() => ""),
		fs.readFile(path.join(beads, "config.yaml"), "utf8").catch(() => ""),
	]);
	return classifyBackend(metadata, config);
}

/**
 * Read the backend of the repository rooted at `cwd`, without touching `bd`.
 *
 * Resolution deliberately ignores an ambient `BEADS_DIR`: the question is which
 * backend THIS checkout carries, and the plugin pins that variable into every
 * session, so honouring it would report the pinned repository's backend for every
 * directory asked about. `sessionPinFor` answers for the checkout itself, still
 * resolving a linked worktree to the primary checkout's database.
 *
 * This is the right resolution for advising about the checkout. Anything that
 * ACTS on a server must instead classify the store it will act on; see the
 * shutdown handler.
 */
export async function readBackend(
	cwd: string,
): Promise<{ backend: Backend; tracked: boolean }> {
	const beads = sessionPinFor(cwd);
	if (beads === undefined) return { backend: "unknown", tracked: false };
	return { backend: await backendAt(beads), tracked: true };
}

/**
 * The advice for a backend, or `undefined` when there is nothing worth saying.
 *
 * Only `embedded` earns a notice. With the machine-wide shared-server default in
 * place (`BEADS_DOLT_SHARED_SERVER=true`), every `bd` command in an embedded project
 * fails with `database not found`, and OMP's isolated subagents fork an embedded
 * store with every clone; the migration below fixes both. Reads are never blocked.
 */
export function backendNotice(
	backend: Backend,
	tracked: boolean,
): string | undefined {
	if (!tracked || backend !== "embedded") return undefined;
	return [
		"beads is on the embedded backend. With this machine's shared-server default every `bd` command here fails with `database not found`, and an OMP isolated subagent forks the store with its clone. Migrate the store to the shared Dolt server:",
		"1. `bd export -o issues.jsonl`, then `bd backup init <dir>` and `bd backup sync` as separate calls (a directory outside the checkout).",
		"2. When `git ls-remote origin 'refs/dolt/*'` is empty: `bd init --shared-server --reinit-local --skip-hooks --skip-agents --prefix <prefix>`, then set `dolt_mode` to `server` in `.beads/metadata.json`, add `dolt.shared-server: true` to `.beads/config.yaml`, and `bd backup restore --force <dir>`.",
		"   Otherwise: `bd dolt push` (on a non-fast-forward, `bd dolt pull` once and push again), make the same two file edits, then `bd bootstrap --yes`.",
		"3. Check `bd count` against the pre-migration count and `bd export` against `issues.jsonl` (ignoring `updated_at`); then move `.beads/embeddeddolt` out of the checkout and commit `.beads/config.yaml` and `.beads/metadata.json`.",
		"Remove `.beads/dolt-backup.json` afterwards: its state file churns inside isolated clones and breaks OMP's merge-back.",
	].join("\n");
}

/**
 * Whether to stop this project's server at session end.
 *
 * Opt-in, and never for the shared server: a `bd dolt stop` there reports success
 * while the process keeps running, because other projects may still hold it.
 */
export function shouldStopServer(
	backend: Backend,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return backend === "per-project" && env[STOP_ON_EXIT] === "1";
}

/**
 * Whether a pid is still live.
 *
 * Signal 0 tests existence without delivering a signal. `EPERM` means the process
 * exists but belongs to another user, so only `ESRCH` proves it is gone.
 */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The process-wide launch lock shared by every checkout using the shared server. */
export const DOLT_START_LOCK_NAME = "omp-dolt-start.lock";
export const DOLT_START_LOCK_ENV = "BEADS_DOLT_START_LOCK";
/** Metadata written inside the launch lock directory. */
export const DOLT_START_HOLDER_NAME = "holder.json";

/** The lock directory used to serialize `bd dolt start` launches. */
export function doltStartLockPath(
	home = process.env.HOME || os.homedir(),
): string {
	return path.join(
		home,
		".beads",
		"shared-server",
		"dolt",
		DOLT_START_LOCK_NAME,
	);
}

export interface DoltStartHolder {
	pid: number;
	cwd: string;
}

/** Stable refusal when another launch owns the lock and its metadata is readable. */
export function doltStartRefusal(holder: DoltStartHolder): string {
	return `bd dolt start refused: another launch is already in progress (holder pid ${holder.pid}, cwd ${holder.cwd}).`;
}

/** Stable refusal when the lock exists but its holder cannot be identified. */
export const DOLT_START_UNKNOWN_REFUSAL =
	"bd dolt start refused: another launch is already in progress, but holder.json is missing or malformed; holder pid/cwd are unknown.";

interface TrackedStart {
	lock: string;
}

interface StartRegistry {
	starts: Map<string, TrackedStart>;
}

const START_REGISTRY_KEY = Symbol.for("com.srobroek.beads.dolt-start-lock.v1");

function startRegistry(): StartRegistry {
	const holder = globalThis as { [START_REGISTRY_KEY]?: StartRegistry };
	const existing = holder[START_REGISTRY_KEY];
	if (existing !== undefined) return existing;
	const created: StartRegistry = { starts: new Map() };
	holder[START_REGISTRY_KEY] = created;
	return created;
}

function holderPath(lock: string): string {
	return path.join(lock, DOLT_START_HOLDER_NAME);
}

function readStartHolder(lock: string): DoltStartHolder | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(holderPath(lock), "utf8"));
		if (parsed === null || typeof parsed !== "object") return undefined;
		const value = parsed as { pid?: unknown; cwd?: unknown };
		if (
			!Number.isSafeInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			typeof value.cwd !== "string" ||
			value.cwd.length === 0
		)
			return undefined;
		return { pid: value.pid as number, cwd: value.cwd };
	} catch {
		return undefined;
	}
}

/** Acquire without waiting; an existing lock always refuses immediately. */
function acquireDoltStart(
	toolCallId: string,
	cwd: string,
	lockPath = doltStartLockPath(),
): { block: true; reason: string } | undefined {
	const registry = startRegistry();
	if (registry.starts.has(toolCallId)) return undefined;
	const lock = lockPath;
	try {
		mkdirSync(path.dirname(lock), { recursive: true });
		mkdirSync(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST")
			return { block: true, reason: DOLT_START_UNKNOWN_REFUSAL };
		const holder = readStartHolder(lock);
		return {
			block: true,
			reason:
				holder === undefined
					? DOLT_START_UNKNOWN_REFUSAL
					: doltStartRefusal(holder),
		};
	}
	try {
		writeFileSync(
			holderPath(lock),
			JSON.stringify({ pid: process.pid, cwd }),
			"utf8",
		);
	} catch {
		// The lock itself remains authoritative; a later caller must refuse with uncertainty.
	}
	registry.starts.set(toolCallId, { lock });
}

function releaseDoltStart(toolCallId: string): void {
	const registry = startRegistry();
	const held = registry.starts.get(toolCallId);
	if (held === undefined) return;
	registry.starts.delete(toolCallId);
	try {
		rmSync(held.lock, { recursive: true, force: true });
	} catch {
		// A matching result has ended our launch; inability to remove the marker is harmless here.
	}
}

/** The server pid recorded in `store`, a resolved `.beads` directory, when usable. */
async function serverPid(store: string): Promise<number | undefined> {
	const raw = await fs
		.readFile(path.join(store, "dolt-server.pid"), "utf8")
		.catch(() => "");
	const pid = Number.parseInt(raw.trim(), 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Stop the server owning `store` and report what actually happened.
 *
 * `bd dolt stop` cannot be taken at its word: on a shared server it prints
 * `Dolt server stopped.` while the process keeps running. The pid recorded before
 * the call is the only thing that settles it.
 *
 * `store` is threaded through rather than re-resolved. The caller classified one
 * directory, and the pid read and the `bd` call must address that same one: this
 * runs at shutdown, where the sibling lifecycle extension is clearing its own
 * `BEADS_DIR` pin, so a second resolution across an await could name another
 * repository's store. Pinning it explicitly for the child settles which store
 * `bd` acts on rather than leaving it to whatever the environment holds.
 */
async function stopServer(
	cwd: string,
	store: string,
): Promise<{ said: string; verdict: string }> {
	const before = await serverPid(store);
	const proc = Bun.spawn(["bd", "dolt", "stop"], {
		cwd,
		env: { ...process.env, BEADS_DIR: store },
		stdout: "pipe",
		stderr: "pipe",
		timeout: 1200,
		killSignal: "SIGKILL",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	const said = `${out}${err}`.trim();
	if (code !== 0)
		return {
			said,
			verdict: `stop failed or timed out (exit ${code}); server state is unverified`,
		};

	if (before === undefined)
		return { said, verdict: "unverifiable: no pid recorded before the call" };
	return {
		said,
		verdict: pidAlive(before)
			? `still running: pid ${before} survived the stop`
			: `stopped: pid ${before} exited`,
	};
}

/**
 * Process-global once-guard. A per-instance flag is not enough: when the plugin
 * is momentarily reachable through two load paths (marketplace install plus a
 * dev link, or an install plus a settings.json extensions entry), the module is
 * instantiated twice and each instance fires its own notice. Keyed on
 * globalThis so every instance shares one flag; observed live on 2026-08-25.
 */
const REPORTED_KEY = Symbol.for("com.srobroek.beads.storage-mode.reported");

export default function beadsDoltLifecycle(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
		try {
			if (event.toolName !== "bash") return;
			const command = extractCommand(event.input);
			if (
				!commandSegments(command).some(
					(segment) => invocation(segment, ["bd", "dolt", "start"]) !== null,
				)
			)
				return;
			const input = event.input as { cwd?: unknown; env?: unknown };
			const cwd =
				typeof input.cwd === "string" && input.cwd.length > 0
					? input.cwd
					: (ctx?.cwd ?? process.cwd());
			const lock =
				input.env !== null &&
				typeof input.env === "object" &&
				!Array.isArray(input.env) &&
				typeof (input.env as Record<string, unknown>)[DOLT_START_LOCK_ENV] ===
					"string"
					? (input.env as Record<string, string>)[DOLT_START_LOCK_ENV]
					: doltStartLockPath();
			return acquireDoltStart(event.toolCallId, cwd, lock);
		} catch {
			return { block: true, reason: DOLT_START_UNKNOWN_REFUSAL };
		}
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		releaseDoltStart(event.toolCallId);
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const holder = globalThis as { [REPORTED_KEY]?: boolean };
		if (holder[REPORTED_KEY]) return;
		holder[REPORTED_KEY] = true;
		try {
			const { backend, tracked } = await readBackend(ctx.cwd);
			const notice = backendNotice(backend, tracked);
			if (notice === undefined) return;
			// Sent as a message rather than a UI notification: the agent runs the `bd`
			// calls this warns about, and `ctx.ui.notify` reaches neither the agent nor
			// a `--print`/RPC session.
			pi.sendMessage(
				{
					customType: "com.srobroek.beads.storage-mode",
					content: notice,
					display: false,
					attribution: "user",
				},
				{ triggerTurn: false },
			);
		} catch (error) {
			pi.logger.error("beads backend check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		try {
			// Only ever stop a server whose store belongs to THIS checkout. Resolving
			// through `beadsDir` would honour an inherited `BEADS_DIR`, and independent
			// review reproduced the consequence: with a foreign pin present, shutdown
			// issued `bd dolt stop` against another repository's store. The session's
			// own bash calls do not necessarily use that pin either -- on a conflict the
			// sibling extension deliberately pins the checkout's own database instead.
			// `BEADS_STOP_SERVER_ON_EXIT` is per-project intent, so when this checkout
			// has no store of its own the correct action is to stop nothing.
			const store = sessionPinFor(ctx.cwd);
			if (store === undefined || !shouldStopServer(await backendAt(store)))
				return;
			const { said, verdict } = await stopServer(ctx.cwd, store);
			// The verdict comes from the pid, not from what bd printed.
			pi.logger.info("beads dolt server stop", { verdict, said });
		} catch (error) {
			pi.logger.error("beads server stop failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
