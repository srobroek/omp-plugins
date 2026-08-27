/**
 * Dolt server lifecycle for beads repositories.
 *
 * Two jobs, both session-scoped, because beads' own session hooks are Claude and
 * Codex JSON wiring that never fires under omp.
 *
 * At session start, report once when a beads repository is on the embedded backend.
 * Embedded resolves a PATH, so a copied checkout or a clone gets its own database.
 * A linked git worktree resolves the primary's store unaided, and still gets the pin, so
 * nobody has to remember which checkout shape they are in.
 * The pin that works is `BEADS_DIR` holding the ABSOLUTE path of the run's `.beads`, set
 * once; children inherit it. A relative value resolves against each process's own working
 * directory, which is the failure the pin exists to prevent.
 *
 * At session end, optionally stop a per-project server. Stopping is safe -- bd
 * flushes the working set first and the next read auto-starts a fresh process -- but
 * it stays opt-in, because a second session in the same repository would pay a
 * restart it did not ask for. The shared server is never stopped: it reports success
 * while continuing to run, since other projects may hold it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

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
		if (parsed !== null && typeof parsed === "object" && "dolt_mode" in parsed) {
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

/** Read the backend of the repository rooted at `cwd`, without touching `bd`. */
export async function readBackend(cwd: string): Promise<{ backend: Backend; tracked: boolean }> {
	const beads = path.join(cwd, ".beads");
	const tracked = await fs
		.stat(beads)
		.then(entry => entry.isDirectory())
		.catch(() => false);
	if (!tracked) return { backend: "unknown", tracked: false };

	const [metadata, config] = await Promise.all([
		fs.readFile(path.join(beads, "metadata.json"), "utf8").catch(() => ""),
		fs.readFile(path.join(beads, "config.yaml"), "utf8").catch(() => ""),
	]);
	return { backend: classifyBackend(metadata, config), tracked: true };
}

/**
 * The advice for a backend, or `undefined` when there is nothing worth saying.
 *
 * Only `embedded` earns a notice. A repository with no `.beads` has no claims to
 * split. Server layouts survive a copy, but they are not the first remedy.
 */
export function backendNotice(backend: Backend, tracked: boolean): string | undefined {
	if (!tracked || backend !== "embedded") return undefined;
	return [
		"beads is on the embedded backend, which resolves by walking up from the working directory.",
		"A copied checkout or a clone gets its own database: claims stop excluding each other, and comments and closures never reach the run.",
		"A linked git worktree resolves the primary checkout's database unaided, and still gets the pin: no checkout shape is exempt.",
		"Fix by exporting `BEADS_DIR` as the ABSOLUTE path of the run's `.beads`, once wherever the run starts; every child process inherits it. A relative value resolves against each process's own working directory.",
		"Unpinned, a read from a directory with no `.beads/` reports `No active beads workspace found`.",
		"Do not pin per call: that pin has to be right on every call, and `BEADS_DIR` is set once.",
		"Switching this project to `--server` is an export, a re-init and a restore, not a flag, and it buys a pid-file lifecycle nobody owns.",
	].join(" ");
}

/**
 * Whether to stop this project's server at session end.
 *
 * Opt-in, and never for the shared server: a `bd dolt stop` there reports success
 * while the process keeps running, because other projects may still hold it.
 */
export function shouldStopServer(backend: Backend, env: NodeJS.ProcessEnv = process.env): boolean {
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

/** The server pid this project recorded, when the value is usable. */
async function serverPid(cwd: string): Promise<number | undefined> {
	const raw = await fs.readFile(path.join(cwd, ".beads", "dolt-server.pid"), "utf8").catch(() => "");
	const pid = Number.parseInt(raw.trim(), 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Stop the project's server and report what actually happened.
 *
 * `bd dolt stop` cannot be taken at its word: on a shared server it prints
 * `Dolt server stopped.` while the process keeps running. The pid recorded before
 * the call is the only thing that settles it.
 */
async function stopServer(cwd: string): Promise<{ said: string; verdict: string }> {
	const before = await serverPid(cwd);
	const proc = Bun.spawn(["bd", "dolt", "stop"], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	const said = `${out}${err}`.trim();

	if (before === undefined) return { said, verdict: "unverifiable: no pid recorded before the call" };
	return { said, verdict: pidAlive(before) ? `still running: pid ${before} survived the stop` : `stopped: pid ${before} exited` };
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
			pi.sendMessage({
				customType: "com.srobroek.beads.storage-mode",
				content: notice,
				display: true,
				attribution: "user",
				triggerTurn: false,
			});
		} catch (error) {
			pi.logger.error("beads backend check failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
		try {
			const { backend } = await readBackend(ctx.cwd);
			if (!shouldStopServer(backend)) return;
			const { said, verdict } = await stopServer(ctx.cwd);
			// The verdict comes from the pid, not from what bd printed.
			pi.logger.info("beads dolt server stop", { verdict, said });
		} catch (error) {
			pi.logger.error("beads server stop failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
