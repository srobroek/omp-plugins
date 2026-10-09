import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A git that never answers. Bun resolves binaries against the PATH it started with, so the
// gate runs in a child bun whose PATH puts the stub first.
describe("hanging git", () => {
	const bin = mkdtempSync(join(tmpdir(), "wt-detached-hang-"));
	writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n");
	chmodSync(join(bin, "git"), 0o755);
	afterAll(() => rmSync(bin, { recursive: true, force: true }));

	test("bounds every removal segment by one budget and names the timeout", () => {
		const script = `import { defaultProbe, reviewCommand } from ${JSON.stringify(join(import.meta.dir, "worktree-detached-guard.ts"))};
const started = Date.now();
const refusal = reviewCommand("wt remove a; wt remove b; wt remove c", ${JSON.stringify(bin)}, defaultProbe({ timeoutMs: 2000, budgetMs: 3000 }));
console.log(JSON.stringify({ refusal, elapsed: Date.now() - started }));`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 20_000,
		});
		const { refusal, elapsed } = JSON.parse(proc.stdout.toString()) as { refusal: string; elapsed: number };
		expect(refusal).toContain("timed out");
		expect(refusal).toContain("git worktree list");
		expect(elapsed).toBeLessThan(6_000);
	}, 25_000);
});
