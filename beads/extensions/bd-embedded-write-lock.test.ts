import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { embeddedWriteTargets, hold, parseLinuxStatStartIdentity, processStartIdentity, release } from "./bd-embedded-write-lock.ts";

const host = hostname().split(".")[0] ?? "localhost";

test("refuses control and timing wrappers instead of bypassing the embedded lock", () => {
	const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-wrapper-"));
	const store = join(root, ".beads");
	const env = { BEADS_DIR: store };
	try {
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "metadata.json"), "{}");
		for (const command of [
			"! bd update bead-1 --claim",
			"time bd update bead-1 --claim",
			"if bd update bead-1 --claim; then :; fi",
			"while bd update bead-1 --claim; do :; done",
			"until bd update bead-1 --claim; do :; done",
		]) {
			const result = embeddedWriteTargets(command, root, env);
			expect(result.kind).toBe("refused");
		}
	const direct = embeddedWriteTargets("bd update bead-1 --claim", root, env);
	expect(direct).toEqual({ kind: "stores", stores: [realpathSync(store)] });
		expect(embeddedWriteTargets("bd show bead-1", root, env)).toEqual({ kind: "stores", stores: [] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parses Linux stat start ticks after a close-paren-space comm", () => {
	const filler = Array.from({ length: 18 }, () => "0").join(" ");
	const stat = `321 (worker) ) name) S ${filler} 4242`;
	expect(parseLinuxStatStartIdentity(stat)).toBe("4242");
});

function writerStartIdentity(pid: number): string {
	const identity = processStartIdentity(pid);
	if (identity === undefined) throw new Error("process start identity unavailable");
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

test("five consecutive acquisitions stay within the bounded wait", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-bounded-"));
    try {
        for (let round = 0; round < 5; round++) {
            const started = Date.now();
            const result = await hold(store, `round-${round}`, 500);
            expect(result).toEqual({ kind: "held" });
            expect(Date.now() - started).toBeLessThan(500);
            release(store, `round-${round}`);
        }
    } finally {
        rmSync(store, { recursive: true, force: true });
    }
});

test("an aborted waiter leaves the queue for the next writer", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-abort-"));
    try {
        expect(await hold(store, "holder", 100)).toEqual({ kind: "held" });
        const controller = new AbortController();
        const waiting = hold(store, "cancelled", 1000, controller.signal);
        controller.abort();
        const cancelled = await waiting;
        expect(cancelled.kind).toBe("failed");
        if (cancelled.kind === "failed") expect(cancelled.reason).toContain("cancelled");
        release(store, "holder");
        expect(await hold(store, "successor", 100)).toEqual({ kind: "held" });
        release(store, "successor");
    } finally {
        rmSync(store, { recursive: true, force: true });
    }
});
});
