import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideMergePolicy } from "./merge-policy-gate.ts";

// git and wt that never answer. Bun resolves binaries against the PATH it started with, so the
// gate runs in a child bun whose PATH puts the stubs first.
describe("hanging probes", () => {
	const bin = mkdtempSync(join(tmpdir(), "merge-gate-hang-"));
	for (const name of ["git", "wt"]) {
		writeFileSync(join(bin, name), "#!/bin/sh\nexec sleep 30\n");
		chmodSync(join(bin, name), 0o755);
	}
	afterAll(() => rmSync(bin, { recursive: true, force: true }));

	test("bounds every probe by one budget and names the timeout", () => {
		const script = `import { decideMergePolicy } from ${JSON.stringify(join(import.meta.dir, "merge-policy-gate.ts"))};
const started = Date.now();
const decision = decideMergePolicy("wt merge orc/epic --no-squash --no-ff", ${JSON.stringify(bin)}, undefined, undefined, { timeoutMs: 2000, budgetMs: 3000 });
console.log(JSON.stringify({ decision, elapsed: Date.now() - started }));`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
		});
		const { decision, elapsed } = JSON.parse(proc.stdout.toString()) as { decision?: { block: boolean; reason: string }; elapsed: number };
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("timed out");
		expect(elapsed).toBeLessThan(6_000);
	}, 25_000);

	test("a failed branch probe names the probe, not the source worktree", () => {
		const git = (args: string[]) => (args[0] === "branch" ? null : "origin/main");
		const decision = decideMergePolicy("wt merge orc/epic --no-squash --no-ff", "/repo", git, () => null);
		expect(decision?.reason).toContain("git branch --show-current");
		expect(decision?.reason).not.toContain("must run from the source worktree");
	});
});
