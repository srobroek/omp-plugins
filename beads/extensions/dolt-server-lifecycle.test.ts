import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import beadsDoltLifecycle from "./dolt-server-lifecycle.ts";
import {
	backendNotice,
	classifyBackend,
	pidAlive,
	readBackend,
	shouldStopServer,
} from "./dolt-server-lifecycle.ts";

const emptyEnv = {} as NodeJS.ProcessEnv;
const stopEnv = { BEADS_STOP_SERVER_ON_EXIT: "1" } as NodeJS.ProcessEnv;
const dirs: string[] = [];

/** A repository whose `.beads` carries exactly the given files. */
async function repo(files: Record<string, string> | null): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "beads-backend-"));
	dirs.push(cwd);
	if (files !== null) {
		await mkdir(join(cwd, ".beads"), { recursive: true });
		for (const [name, body] of Object.entries(files)) {
			await writeFile(join(cwd, ".beads", name), body);
		}
	}
	return cwd;
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("classifyBackend", () => {
	test("the flat dotted key is what bd actually writes for a shared server", () => {
		// Verbatim from a scratch `bd init --shared-server`, which writes a flat
		// `dolt.shared-server` key rather than the nested block a reader assumes.
		const config = "dolt.shared-server: true\ndolt.host: 127.0.0.1\n";
		expect(classifyBackend('{"dolt_mode":"server"}', config)).toBe("shared");
	});

	test("a nested block a human might hand-write is read too", () => {
		expect(classifyBackend("{}", "dolt:\n  shared-server: true\n")).toBe("shared");
	});

	test("a commented-out key is not a shared server", () => {
		expect(classifyBackend('{"dolt_mode":"embedded"}', "# dolt.shared-server: true\n")).toBe("embedded");
	});

	test("per-project server mode is declared only in metadata", () => {
		// `bd init --server` sets the metadata field and no config key at all, so a
		// config-only reader would call this project embedded and nag it forever.
		expect(classifyBackend('{"dolt_mode":"server","dolt_database":"omp_orchestrate"}', "")).toBe("per-project");
	});

	test("shared wins when both carriers are present", () => {
		expect(classifyBackend('{"dolt_mode":"server"}', "dolt.shared-server: true\n")).toBe("shared");
	});

	test("malformed or absent metadata proves nothing either way", () => {
		expect(classifyBackend("{ not json", "")).toBe("unknown");
		expect(classifyBackend("", "")).toBe("unknown");
		expect(classifyBackend("null", "")).toBe("unknown");
		expect(classifyBackend("[1,2]", "")).toBe("unknown");
	});

	test("a non-string dolt_mode is not a mode", () => {
		expect(classifyBackend('{"dolt_mode":3}', "")).toBe("unknown");
	});
});

describe("readBackend", () => {
	test("a repository with no .beads is untracked", async () => {
		expect(await readBackend(await repo(null))).toEqual({ backend: "unknown", tracked: false });
	});

	test("the default bd init layout reads as embedded", async () => {
		const cwd = await repo({ "metadata.json": '{"dolt_mode":"embedded"}' });
		expect(await readBackend(cwd)).toEqual({ backend: "embedded", tracked: true });
	});

	test("a tracked repo with unreadable carriers is tracked but unknown", async () => {
		expect(await readBackend(await repo({}))).toEqual({ backend: "unknown", tracked: true });
	});
});

describe("backendNotice", () => {
	test("only embedded earns a notice", () => {
		expect(backendNotice("embedded", true)).toContain("bd init --server");
		expect(backendNotice("per-project", true)).toBeUndefined();
		expect(backendNotice("shared", true)).toBeUndefined();
	});

	test("a repository with no beads has no claims to split", () => {
		// The precondition does not apply, and saying so anyway is noise.
		expect(backendNotice("unknown", false)).toBeUndefined();
		expect(backendNotice("embedded", false)).toBeUndefined();
	});

	test("the notice names the consequence, not just the flag", () => {
		const notice = backendNotice("embedded", true) ?? "";
		expect(notice).toContain("claims stop excluding each other");
		expect(notice).toContain("bd -C");
	});
});

describe("shouldStopServer", () => {
	test("opt-in only", () => {
		expect(shouldStopServer("per-project", stopEnv)).toBe(true);
		expect(shouldStopServer("per-project", emptyEnv)).toBe(false);
	});

	test("never the shared server, even when asked", () => {
		// Its `bd dolt stop` reports success while the process keeps running, because
		// other projects may still hold it.
		expect(shouldStopServer("shared", stopEnv)).toBe(false);
	});

	test("nothing to stop for embedded or unknown", () => {
		expect(shouldStopServer("embedded", stopEnv)).toBe(false);
		expect(shouldStopServer("unknown", stopEnv)).toBe(false);
	});

	test("only an exact opt-in counts", () => {
		expect(shouldStopServer("per-project", { BEADS_STOP_SERVER_ON_EXIT: "true" } as NodeJS.ProcessEnv)).toBe(false);
		expect(shouldStopServer("per-project", { BEADS_STOP_SERVER_ON_EXIT: "0" } as NodeJS.ProcessEnv)).toBe(false);
	});
});

describe("pidAlive", () => {
	test("this process is alive", () => {
		expect(pidAlive(process.pid)).toBe(true);
	});

	test("pid 1 is alive and not ours, so EPERM must read as alive", () => {
		// The discriminator for the error branch: signal 0 against init raises EPERM
		// rather than ESRCH. Reading EPERM as dead would report a live server stopped.
		expect(pidAlive(1)).toBe(true);
	});

	test("a reaped pid is dead", async () => {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		const pid = proc.pid;
		await proc.exited;
		// Bun has reaped it, so the pid holds no process and no zombie.
		expect(pidAlive(pid)).toBe(false);
	});
});

describe("cross-instance once-guard", () => {
	test("two module instances emit exactly one storage-mode notice", async () => {
		// Two load paths (install + link, or install + settings extensions entry)
		// instantiate the module twice; the notice must still appear once.
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("com.srobroek.beads.storage-mode.reported")];
		const cwd = await repo({ "metadata.json": '{"dolt_mode":"embedded"}' });
		const sent: unknown[] = [];
		const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				if (name === "session_start") handlers.push(handler);
			},
			sendMessage: (message: unknown) => {
				sent.push(message);
			},
			logger: { error: () => {} },
		};
		beadsDoltLifecycle(pi as never);
		beadsDoltLifecycle(pi as never);
		for (const handler of handlers) await handler({}, { cwd });
		expect(handlers.length).toBe(2);
		expect(sent.length).toBe(1);
	});
});
