import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { hold, release } from "./bd-embedded-write-lock.ts";

const host = hostname().split(".")[0] ?? "localhost";

function writerStartIdentity(pid: number): string {
	const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
	if (result.exitCode !== 0) throw new Error("ps could not report the test process start identity");
	const identity = result.stdout.toString().trim();
	if (identity === "") throw new Error("ps returned no test process start identity");
	return identity;
}

describe("embedded write lock", () => {
	test("recovers an expired lock when the writer PID has been reused", async () => {
		const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-pid-reuse-"));
		try {
			writeFileSync(join(store, "omp-embedded-write.lock"), JSON.stringify({
				host,
				pid: process.pid,
				owner: "old",
				token: "old-token",
				taken: Date.now() - 1000,
				expires: Date.now() - 1,
				writer: process.pid,
				writerStart: "a different process start",
			}));
			const result = await hold(store, "replacement", 100);
			expect(result).toEqual({ kind: "held" });
			release(store, "replacement");
		} finally {
			rmSync(store, { recursive: true, force: true });
		}
	});

	test("protects an expired lock while the writer identity is still live", async () => {
		const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-live-writer-"));
		try {
			writeFileSync(join(store, "omp-embedded-write.lock"), JSON.stringify({
				host,
				pid: process.pid,
				owner: "live",
				token: "live-token",
				taken: Date.now() - 1000,
				expires: Date.now() - 1,
				writer: process.pid,
				writerStart: writerStartIdentity(process.pid),
			}));
			const result = await hold(store, "blocked", 35);
			expect(result.kind).toBe("failed");
			if (result.kind === "failed") expect(result.reason).toContain("stayed held");
		} finally {
			rmSync(store, { recursive: true, force: true });
		}
	});

	test("old-owner exit cannot delete a successor lock after takeover", async () => {
		const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-exit-race-"));
		const ready = join(store, "ready");
		const done = join(store, "done");
		const modulePath = join(import.meta.dir, "bd-embedded-write-lock.ts");
		const script = `
import { existsSync, writeFileSync } from "node:fs";
import { hold, setLeaseTimingForTests } from ${JSON.stringify(modulePath)};
setLeaseTimingForTests(80, 1000);
const result = await hold(process.argv[1], "old-owner", 2000);
if (result.kind !== "held") process.exit(2);
writeFileSync(process.argv[2], "ready");
			// Coordination with a child process requires the platform clock rather than fake timers.
			while (!existsSync(process.argv[3])) await Bun.sleep(10);
`;
		const child = Bun.spawn([process.execPath, "-e", script, store, ready, done], { stdout: "ignore", stderr: "pipe" });
		try {
			const deadline = Date.now() + 3000;
			while (!existsSync(ready)) {
				if (Date.now() >= deadline) throw new Error("old-owner test process did not become ready");
				await Bun.sleep(10);
			}
			const lock = join(store, "omp-embedded-write.lock");
			const old = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>;
			old.expires = Date.now() - 1;
			writeFileSync(lock, JSON.stringify(old));
			const successor = await hold(store, "successor", 500);
			expect(successor).toEqual({ kind: "held" });
			writeFileSync(done, "exit");
			await child.exited;
			expect(existsSync(lock)).toBe(true);
			release(store, "successor");
		} finally {
			if (child.exitCode === null) child.kill();
			rmSync(store, { recursive: true, force: true });
		}
	});

});
