/**
 * Dolt server lifecycle for beads repositories.
 *
 * Two jobs, both session-scoped, because beads' own session hooks are Claude and
 * Codex JSON wiring that never fires under omp.
 *
 * At session start, report once when a beads repository is on the embedded backend.
 * Embedded resolves a PATH, so any harness that isolates work by copying the
 * checkout hands each agent its own database: measured on a 54-bead project, a plain
 * `cp -R` produced a fully writable copy whose creates and claims never reached the
 * original. Nothing errors, which is what makes it worth saying out loud.
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
 * split, and both server layouts already survive a copy.
 */
export function backendNotice(backend: Backend, tracked: boolean): string | undefined {
	if (!tracked || backend !== "embedded") return undefined;
	return [
		"beads is on the embedded backend, which resolves by walking up from the working directory.",
		"Any harness that isolates work by copying the checkout gives each agent its own database:",
		"claims stop excluding each other, and comments and closures never reach the run.",
		"Fix with `bd init --server` on a new project, a backup-and-restore migration on this one,",
		"or by aiming every call at the run's checkout with `bd -C <repo>`.",
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

/** Stop the project's server, returning what bd said. */
async function stopServer(cwd: string): Promise<string> {
	const proc = Bun.spawn(["bd", "dolt", "stop"], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return `${out}${err}`.trim();
}

export default function beadsDoltLifecycle(pi: ExtensionAPI): void {
	let reported = false;

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (reported) return;
		reported = true;
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
			const said = await stopServer(ctx.cwd);
			// Reported rather than trusted: the shared server's stop lies, and a
			// per-project stop should say it flushed before exiting.
			pi.logger.info("beads dolt server stop requested", { said });
		} catch (error) {
			pi.logger.error("beads server stop failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}
