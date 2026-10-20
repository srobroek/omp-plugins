import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
		const runner = embeddedWriteRunner(import.meta.dir, () => interpreter);
		if ("unavailable" in runner) throw new Error(runner.unavailable);
		if (interpreter === undefined) return;
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
test("after an upgrade deletes the loaded version, the write runs through the newest installed runner", async () => {
	const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-upgrade-"));
	const cache = join(root, "cache", "plugins");
	const loadedDist = join(cache, "srobroek-omp___beads___3.2.0", "dist");
	const store = join(root, ".beads");
	const bin = join(root, "bin");
	const ranBy = join(root, "ran-by");
	const bdArgs = join(root, "bd-args");
	const realRunner = join(import.meta.dir, "bd-embedded-write-runner.ts");
	const install = (dir: string) => {
		mkdirSync(join(cache, dir, "dist"), { recursive: true });
		writeFileSync(
			join(cache, dir, "dist", "bd-embedded-write-runner.js"),
			`import { writeFileSync } from "node:fs";\nimport { main } from ${JSON.stringify(realRunner)};\nwriteFileSync(${JSON.stringify(ranBy)}, ${JSON.stringify(dir)});\nprocess.exitCode = await main(process.argv.slice(2));\n`,
		);
	};
	const command = "bd update bead-1 --claim";
	const event = { toolName: "bash", toolCallId: "upgrade", input: { command, cwd: root, env: { BEADS_DIR: store } } } as unknown as Parameters<typeof decideEmbeddedWrite>[1];
	try {
		install("srobroek-omp___beads___3.10.0");
		install("srobroek-omp___beads___4.0.0-rc.1");
		install("srobroek-omp___beads___4.0.0");
		install("other-market___beads___9.0.0");
		mkdirSync(join(cache, "srobroek-omp___beads___not-a-version", "dist"), { recursive: true });
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "metadata.json"), "{}");
		mkdirSync(bin);
		writeFileSync(join(bin, "bd"), `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(bdArgs)}\n`, { mode: 0o755 });
		const decision = await decideEmbeddedWrite(parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0], event, { cwd: root } as unknown as Parameters<typeof decideEmbeddedWrite>[2], Date.now() + 5000, () => embeddedWriteRunner(loadedDist, () => process.execPath));
		if (decision?.kind !== "rewrite") throw new Error(`expected a rewrite, got ${JSON.stringify(decision)}`);
		if (typeof decision.input.command !== "string") throw new Error("embedded rewrite returned no command");
		expect(decision.input.command).toContain(join(cache, "srobroek-omp___beads___4.0.0", "dist", "bd-embedded-write-runner.js"));
		const run = Bun.spawnSync(["/bin/sh", "-c", decision.input.command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).toBe(0);
		expect(readFileSync(ranBy, "utf8")).toBe("srobroek-omp___beads___4.0.0");
		expect(readFileSync(bdArgs, "utf8")).toBe("update bead-1 --claim");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, { timeout: 15_000 });

test("refuses the write, naming the missing runner, when no installed version provides one", async () => {
	const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-no-runner-"));
	const cache = join(root, "cache", "plugins");
	const loadedDist = join(cache, "srobroek-omp___beads___3.2.0", "dist");
	const store = join(root, ".beads");
	const command = "bd update bead-1 --claim";
	const event = { toolName: "bash", toolCallId: "no-runner", input: { command, cwd: root, env: { BEADS_DIR: store } } } as unknown as Parameters<typeof decideEmbeddedWrite>[1];
	try {
		mkdirSync(join(cache, "srobroek-omp___beads___4.0.0", "dist"), { recursive: true });
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "metadata.json"), "{}");
		const decision = await decideEmbeddedWrite(parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0], event, { cwd: root } as unknown as Parameters<typeof decideEmbeddedWrite>[2], Date.now() + 5000, () => embeddedWriteRunner(loadedDist, () => process.execPath));
		if (decision?.kind !== "block") throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`);
		expect(decision.reason).toContain(join(loadedDist, "bd-embedded-write-runner.js"));
		expect(decision.reason).toContain("restart the session");
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

describe("compound commands", () => {
	const runner = { interpreter: "/opt/bun", script: "/opt/beads/extensions/bd-embedded-write-runner.js" };
	let root = "";
	let store = "";
	let other = "";
	/** The canonical spelling the rewrite uses; `/tmp` is a symlink on macOS. */
	let held = "";
	let heldOther = "";
	const runnerForm = (target: string, using = runner) => `BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${target}' '${using.interpreter}' '${using.script}' --beads-store '${target}' --beads-wait-ms 120000 -- `;

	beforeAll(() => {
		root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-compound-"));
		store = join(root, ".beads");
		other = join(root, "other", ".beads");
		for (const dir of [store, other]) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "metadata.json"), "{}");
		}
		held = realpathSync(store);
		heldOther = realpathSync(other);
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	async function decide(command: string, using = runner) {
		const event = { toolName: "bash", toolCallId: `compound:${command}`, input: { command, cwd: root, env: { BEADS_DIR: store } } } as unknown as Parameters<typeof decideEmbeddedWrite>[1];
		return decideEmbeddedWrite(parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0], event, { cwd: root } as unknown as Parameters<typeof decideEmbeddedWrite>[2], Date.now() + 2000, () => using);
	}

	async function rewritten(command: string, using = runner): Promise<string> {
		const decision = await decide(command, using);
		if (decision?.kind !== "rewrite" || typeof decision.input.command !== "string") throw new Error(`expected a rewrite of ${command}, got ${JSON.stringify(decision)}`);
		return decision.input.command;
	}

	async function refusal(command: string): Promise<string> {
		const decision = await decide(command);
		if (decision?.kind !== "block") throw new Error(`expected a refusal of ${command}, got ${JSON.stringify(decision)}`);
		return decision.reason;
	}

	test("passes reads anywhere in a compound command, unchanged", async () => {
		for (const command of [
			"git status -sb; git log --oneline -3; bd list --status=open 2>&1 | head -40",
			"bd prime 2>&1 | head -120; echo '--- primed'",
			"bd show bd-1 --json | jq '.[0].status'",
			"bd ready --json | jq -r '.[].id' > ready.txt",
			"( bd stats ) && { bd search lock; bd comments bd-1 --json; }",
			"if bd show bd-1 >/dev/null 2>&1; then echo present; fi",
			"bd close --help | head",
			"bd --readonly update bd-1 --claim && echo checked",
			"git commit -m 'teach bd close a flag' && rg -n 'bd close' .",
		]) {
			expect(await decide(command)).toBeUndefined();
		}
	});

	test("runs each write under the runner in place and leaves the reads around it alone", async () => {
		const lock = runnerForm(held);
		expect(await rewritten(`export BEADS_DIR=${store}; bd update bd-1 --claim`)).toBe(`export BEADS_DIR=${store}; ${lock}bd update bd-1 --claim`);
		expect(await rewritten("bd close bd-1 --reason 'done; merged | verified' && git push")).toBe(`${lock}bd close bd-1 --reason 'done; merged | verified' && git push`);
		expect(await rewritten("git status -sb; bd list | head; bd close bd-1; bd show bd-1 --json | jq .")).toBe(`git status -sb; bd list | head; ${lock}bd close bd-1; bd show bd-1 --json | jq .`);
		expect(await rewritten("for id in bd-1 bd-2; do bd close \"$id\"; done")).toBe(`for id in bd-1 bd-2; do ${lock}bd close "$id"; done`);
	});

	test("keeps pipes from and to a write", async () => {
		const lock = runnerForm(held);
		expect(await rewritten("bd create 'Fix it' --silent | xargs echo created")).toBe(`${lock}bd create 'Fix it' --silent | xargs echo created`);
		expect(await rewritten("bd list --status open -q | awk '{print \"close\", $2}' | bd batch")).toBe(`bd list --status open -q | awk '{print "close", $2}' | ${lock}bd batch`);
		expect(await rewritten("bd update bd-1 --claim |& tee claim.log")).toBe(`${lock}bd update bd-1 --claim |& tee claim.log`);
	});

	test("gives every write in a list its own runner", async () => {
		const lock = runnerForm(held);
		expect(await rewritten("bd close bd-1 && bd close bd-2 || bd update bd-3 --claim; bd list")).toBe(`${lock}bd close bd-1 && ${lock}bd close bd-2 || ${lock}bd update bd-3 --claim; bd list`);
	});

	test("keeps redirections, quoted separators and here-document data byte for byte", async () => {
		const lock = runnerForm(held);
		expect(await rewritten('{ bd list; bd update bd-1 --notes "a; b | c && d"; } > out.txt 2>&1 &')).toBe(`{ bd list; ${lock}bd update bd-1 --notes "a; b | c && d"; } > out.txt 2>&1 &`);
		expect(await rewritten("bd update bd-1 --notes 'x; bd close bd-2 | y' 2>/dev/null")).toBe(`${lock}bd update bd-1 --notes 'x; bd close bd-2 | y' 2>/dev/null`);
		const heredoc = "bd create 'Task' --body-file - <<'EOF'\nThen run bd dep add; pipe | here\nEOF\necho made";
		expect(await rewritten(heredoc)).toBe(`${lock}${heredoc}`);
		expect(await rewritten("BEADS_ACTOR=me bd close bd-1 > closed.txt")).toBe(`BEADS_ACTOR=me ${lock}bd close bd-1 > closed.txt`);
	});

	test("locks the store each write targets, including command-local and exported BEADS_DIR", async () => {
		expect(await rewritten(`BEADS_DIR=${other} bd close bd-1; bd close bd-2`)).toBe(`BEADS_DIR=${other} ${runnerForm(heldOther)}bd close bd-1; ${runnerForm(held)}bd close bd-2`);
		expect(await rewritten(`export BEADS_DIR=${other} && bd close bd-1`)).toBe(`export BEADS_DIR=${other} && ${runnerForm(heldOther)}bd close bd-1`);
		// A subshell's export does not reach the write after it.
		expect(await rewritten(`(export BEADS_DIR=${other}; bd close bd-1); bd close bd-2`)).toBe(`(export BEADS_DIR=${other}; ${runnerForm(heldOther)}bd close bd-1); ${runnerForm(held)}bd close bd-2`);
	});

	test("leaves an already rewritten command untouched and refuses a runner holding the wrong store", async () => {
		const once = await rewritten("git status; bd close bd-1 && bd update bd-2 --claim | cat");
		expect(await decide(once)).toBeUndefined();
		const forged = `BEADS_DIR='${held}' '/opt/bun' '/opt/beads/extensions/bd-embedded-write-runner.js' --beads-store '${heldOther}' -- bd close bd-1`;
		expect(await refusal(forged)).toContain(`a runner command holds \`${heldOther}\``);
	});

	test("refuses, with the part it could not place, every shape it cannot locate or resolve", async () => {
		for (const [command, part] of [
			['echo "$(bd close bd-1)"', "command substitution"],
			["ID=$(bd create 'Task' --silent) && echo $ID", "command substitution"],
			["jq . <<< `bd show bd-1 --json`", "command substitution"],
			["eval 'bd close bd-1'", "shell source to `eval`"],
			["bash -c 'bd close bd-1'", "shell source to `bash`"],
			['git status && sh -c "bd update bd-1 --claim"', "shell source to `sh`"],
			["echo bd-1 | xargs bd close", "launched through `xargs`"],
			["timeout 60 bd close bd-1", "launched through `timeout`"],
			["B=bd; $B close bd-1", "`$B` is expanded at run time"],
			["bash <<'EOF'\nbd close bd-1\nEOF", "here-document fed to `bash`"],
			["BEADS_DIR=$X bd close bd-1", "set by `BEADS_DIR=$X`"],
			['export BEADS_DIR="$HOME/.beads"; bd close bd-1', 'set by `BEADS_DIR="$HOME/.beads"`'],
			["bd -C $DIR close bd-1", "`-C $DIR`"],
			["if bd update bd-1 --claim; then :; fi", "follows `if`"],
			["cd sub; bd -C rel close bd-1", "relative `-C` path"],
		] as const) {
			const reason = await refusal(command);
			expect(reason).toContain(part);
			expect(reason).toContain("Accepted:");
		}
		expect(await refusal("cd $WORKTREE; git pull && bd close bd-1")).toBe("This command changes directory dynamically; issue the `bd` command with the tool's cwd field instead.");
	});

	test("classifies only verified bd 1.3.1 read forms as reads", () => {
		const stores = (command: string) => embeddedWriteTargets(command, root, { BEADS_DIR: store });
		// `bd dep show -b X` is the parent `bd dep <id> --blocks` form; `bd comment list` comments on `list`.
		for (const command of ["bd dep show -b bd-2", "bd comment list", "bd orphans $FLAGS", "bd epic list"]) {
			expect(stores(command)).toEqual({ kind: "stores", stores: [held] });
		}
		for (const command of ["bd stats --json", "bd comments bd-1 --json", "bd dep tree bd-1", "bd mol show mol-1"]) {
			expect(stores(command)).toEqual({ kind: "stores", stores: [] });
		}
	});

	test("runs each write in a compound command under its own hold, one after another", async () => {
		const bin = join(root, "bin");
		const log = join(root, "writes.log");
		mkdirSync(bin, { recursive: true });
		// A stand-in `bd` that records, at its start, whether the hold names this very
		// process as the writer, and sleeps long enough for an overlapping writer to show.
		writeFileSync(
			join(bin, "bd"),
			`#!/bin/sh\nheld=$(grep -c "\\"writer\\":$$," "$BEADS_DIR/omp-embedded-write.lock")\nprintf 'start %s %s\\n' "$2" "$held" >> ${JSON.stringify(log)}\nsleep 0.2\nprintf 'end %s\\n' "$2" >> ${JSON.stringify(log)}\n`,
			{ mode: 0o755 },
		);
		const real = { interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") };
		// The pipe starts both writes at once; only the lock keeps them apart.
		const command = await rewritten("bd update bd-1 --claim | bd update bd-2 --claim; bd close bd-3 && echo ok", real);
		const run = Bun.spawnSync(["/bin/sh", "-c", command], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).toBe(0);
		expect(new TextDecoder().decode(run.stdout)).toBe("ok\n");
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines).toHaveLength(6);
		for (let at = 0; at < lines.length; at += 2) {
			const [, id, writer] = lines[at]?.split(" ") ?? [];
			expect(writer).toBe("1");
			expect(lines[at + 1]).toBe(`end ${id}`);
		}
		expect(lines.filter(line => line.startsWith("start")).map(line => line.split(" ")[1]).sort()).toEqual(["bd-1", "bd-2", "bd-3"]);
		expect(existsSync(join(held, "omp-embedded-write.lock"))).toBe(false);
	}, { timeout: 15_000 });
});
