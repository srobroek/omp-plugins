import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { decideEmbeddedWrite, embeddedWriteRunner, embeddedWriteTargets, hold, parseLinuxStatStartIdentity, processStartIdentity, release, resolveBunBinary } from "./bd-embedded-write-lock.ts";
import { main as runEmbeddedWriter, setCommandTimeoutForTests } from "./bd-embedded-write-runner.ts";
import { parse } from "./shell-command.ts";

const host = hostname().split(".")[0] ?? "localhost";
/** The scratch-store proof drives the real bd CLI; CI images without bd skip it. */
const BD_ON_PATH = Bun.which("bd") !== null;
test("resolves mise-only Bun and completes a real runner write", () => {
	const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-mise-"));
	const marker = join(root, "written");
	try {
		const interpreter = resolveBunBinary({
			execPath: "/opt/omp/omp",
			which: name => name === "mise" ? "/opt/mise/bin/mise" : undefined,
			environment: {},
			miseWhich: () => process.execPath,
		});
		expect(interpreter).toBe(process.execPath);
		const runner = embeddedWriteRunner();
		expect(runner).not.toBeUndefined();
		if (runner === undefined || interpreter === undefined) return;
		const result = Bun.spawnSync([interpreter, runner.script, "--beads-store", root, "--", "/bin/sh", "-c", `printf written > ${JSON.stringify(marker)}`], { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("written");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(!BD_ON_PATH)("decideEmbeddedWrite rewrites a mise-only runner against a scratch store", async () => {
	const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-mise-proof-"));
	const store = join(root, ".beads");
	const env = { ...process.env, BEADS_DIR: store, BEADS_ACTOR: "omp/test/qycs" };
	try {
		const init = Bun.spawnSync(["bd", "init", "--init-if-missing", "--skip-hooks"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		expect(init.exitCode).toBe(0);
		const command = "bd create --type task --title mise-runner-proof --json";
		const event = { toolName: "bash", toolCallId: "mise-proof", input: { command, cwd: root, env: { BEADS_DIR: store, BEADS_ACTOR: "omp/test/qycs" } } } as unknown as Parameters<typeof decideEmbeddedWrite>[1];
		const parsed = parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0];
		const decision = await decideEmbeddedWrite(parsed, event, { cwd: root } as unknown as Parameters<typeof decideEmbeddedWrite>[2], Date.now() + 5000, () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }));
		expect(decision?.kind).toBe("rewrite");
		if (decision?.kind !== "rewrite") return;
		expect(decision.input.env).toBeUndefined();
		expect(decision.input.ready).toBeUndefined();
		expect(decision.input.pty).toBeUndefined();
		if (typeof decision.input.command !== "string") throw new Error("embedded rewrite returned no command");
		expect(decision.input.command).toContain("BEADS_DOLT_SHARED_SERVER= BEADS_DIR=");
		const run = Bun.spawnSync(["/bin/sh", "-c", decision.input.command], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).toBe(0);
		const created = JSON.parse(new TextDecoder().decode(run.stdout)) as { id?: unknown };
		expect(typeof created.id).toBe("string");
		if (typeof created.id !== "string") return;
		const shown = Bun.spawnSync(["bd", "show", created.id, "--json"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		expect(shown.exitCode).toBe(0);
		expect(new TextDecoder().decode(shown.stdout)).toContain("mise-runner-proof");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 30_000 });


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
			"env -u BEADS_DIR bd update bead-1 --claim",
			"env -u BEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
			"env --unset BEADS_DIR bd update bead-1 --claim",
			"env --unset BEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
			"env -uBEADS_DIR bd update bead-1 --claim",
			"env -uBEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
			"env --unset=BEADS_DIR bd update bead-1 --claim",
			"env --unset=BEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
			"env -i bd update bead-1 --claim",
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
	test.skipIf(process.platform !== "linux")("recovers an expired lock when the writer PID has been reused", async () => {
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
test("lock timeout identifies the holder and lock age", async () => {
	const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-diagnostic-"));
	try {
		writeFileSync(join(store, "omp-embedded-write.lock"), JSON.stringify({ host, pid: process.pid, owner: "runner-live", token: "held", taken: Date.now() - 1000, expires: Date.now() + 10000 }));
		const result = await hold(store, "waiter", 30);
		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.reason).toContain("holder runner-live");
			expect(result.reason).toMatch(/age \d+s/);
		}
	} finally {
		rmSync(store, { recursive: true, force: true });
	}
});

test("parallel runner acquisitions do not refuse ordinary short writes", async () => {
	const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-contention-"));
	const runner = join(import.meta.dir, "bd-embedded-write-runner.ts");
	const children = Array.from({ length: 10 }, () => Bun.spawn([process.execPath, runner, "--beads-store", store, "--beads-wait-ms", "30000", "--", "/bin/sleep", "0.02"], { stdout: "ignore", stderr: "pipe" }));
	try {
		const statuses = await Promise.all(children.map(child => child.exited));
		expect(statuses).toEqual(Array.from({ length: 10 }, () => 0));
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		rmSync(store, { recursive: true, force: true });
	}
});

test("runner refuses a queued writer at its lock deadline", async () => {
	const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-wait-"));
	const runner = join(import.meta.dir, "bd-embedded-write-runner.ts");
	const fakeBd = join(store, "bd");
	writeFileSync(fakeBd, "#!/bin/sh\nsleep 0.2\n", { mode: 0o755 });
	const first = Bun.spawn([process.execPath, runner, "--beads-store", store, "--beads-wait-ms", "1000", "--", fakeBd, "update", "bead-1"], { stdout: "ignore", stderr: "ignore" });
	try {
		const lock = join(store, "omp-embedded-write.lock");
		const deadline = Date.now() + 2000;
		while (!existsSync(lock)) {
			// Separate runner processes and the OS lock use the platform clock; fake timers cannot drive this integration boundary.
			await Bun.sleep(5);
			if (Date.now() >= deadline) throw new Error("first runner did not acquire the lock");
		}
		const second = Bun.spawn([process.execPath, runner, "--beads-store", store, "--beads-wait-ms", "25", "--", fakeBd, "update", "bead-2"], { stdout: "ignore", stderr: "ignore" });
		expect(await second.exited).toBe(120);
		expect(await first.exited).toBe(0);
	} finally {
		if (first.exitCode === null) {
			first.kill("SIGTERM");
			await first.exited;
		}
		rmSync(store, { recursive: true, force: true });
	}
});

test("accepts a literal cd prefix while refusing dynamic cwd", async () => {
	const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-cwd-"));
	const store = join(root, ".beads");
	const event = (command: string) => ({ toolName: "bash", toolCallId: command, input: { command, cwd: root, env: { BEADS_DIR: store } } }) as unknown as Parameters<typeof decideEmbeddedWrite>[1];
	try {
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "metadata.json"), "{}");
		const literal = "cd . && bd update bead-1 --claim";
		const decision = await decideEmbeddedWrite(parse(literal) as unknown as Parameters<typeof decideEmbeddedWrite>[0], event(literal), { cwd: root } as unknown as Parameters<typeof decideEmbeddedWrite>[2], Date.now() + 2000, () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }));
		expect(decision?.kind).toBe("rewrite");
		const dynamic = "cd $WORKTREE && bd update bead-1 --claim";
		const refused = await decideEmbeddedWrite(parse(dynamic) as unknown as Parameters<typeof decideEmbeddedWrite>[0], event(dynamic), { cwd: root } as unknown as Parameters<typeof decideEmbeddedWrite>[2], Date.now() + 2000, () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }));
		expect(refused).toEqual({ kind: "block", reason: "This command changes directory dynamically; issue the `bd` command with the tool's cwd field instead." });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("terminates a hung short embedded child and releases its lock", async () => {
	const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-timeout-"));
	const fakeBd = join(store, "bd");
	writeFileSync(fakeBd, "#!/bin/sh\nsleep 1\n", { mode: 0o755 });
	setCommandTimeoutForTests(25);
	try {
		const result = await runEmbeddedWriter(["--beads-store", store, "--", fakeBd, "update", "bead-1"]);
		expect(result).toBe(124);
		expect(existsSync(join(store, "omp-embedded-write.lock"))).toBe(false);
	} finally {
		setCommandTimeoutForTests();
		rmSync(store, { recursive: true, force: true });
	}
});

test("leaves long embedded maintenance writes to their own lifecycle", async () => {
	const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-long-"));
	const fakeBd = join(store, "bd");
	writeFileSync(fakeBd, "#!/bin/sh\nsleep 0.1\n", { mode: 0o755 });
	setCommandTimeoutForTests(25);
	try {
		const result = await runEmbeddedWriter(["--beads-store", store, "--", fakeBd, "gc"]);
		expect(result).toBe(0);
	} finally {
		setCommandTimeoutForTests();
		rmSync(store, { recursive: true, force: true });
	}
});
