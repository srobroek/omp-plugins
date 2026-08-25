import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import unpushedWorkAdvisory, {
	formatAdvisory,
	handleSessionStop,
	hasGitDir,
	parsePorcelain,
	resetUnpushedAdvisoryForTests,
	shouldAdvise,
} from "./unpushed-work-advisory.ts";

describe("parsePorcelain", () => {
	test("ahead and dirty tracked", () => {
		const s = parsePorcelain(
			["## feature...origin/feature [ahead 2]", " M src/a.ts", "?? scratch"].join("\n"),
		);
		expect(s.branch).toBe("feature");
		expect(s.ahead).toBe(2);
		expect(s.dirtyTracked).toBe(1);
		expect(s.untracked).toBe(1);
		expect(shouldAdvise(s)).toBe(true);
	});

	test("clean tracking branch", () => {
		const s = parsePorcelain("## main...origin/main\n");
		expect(s.ahead).toBe(0);
		expect(s.dirtyTracked).toBe(0);
		expect(shouldAdvise(s)).toBe(false);
	});

	test("untracked only does not advise", () => {
		const s = parsePorcelain(["## main", "?? foo"].join("\n"));
		expect(shouldAdvise(s)).toBe(false);
	});

	test("format names branch and counts", () => {
		const text = formatAdvisory({
			branch: "wip",
			ahead: 3,
			behind: 0,
			dirtyTracked: 2,
			untracked: 0,
		});
		expect(text).toContain("wip");
		expect(text).toContain("3");
		expect(text).toContain("2");
		expect(text).toContain("delivery-cadence");
	});
});

describe("handleSessionStop", () => {
	test("skips when stop_hook_active", () => {
		resetUnpushedAdvisoryForTests();
		expect(
			handleSessionStop({ stop_hook_active: true }, "/tmp", "## x [ahead 1]\n"),
		).toBeUndefined();
	});

	test("continues with context when ahead", () => {
		resetUnpushedAdvisoryForTests();
		const r = handleSessionStop({}, "/tmp", "## feat [ahead 1]\n");
		expect(r?.continue).toBe(true);
		expect(r?.additionalContext).toContain("feat");
	});

	test("does not fire twice in a row", () => {
		resetUnpushedAdvisoryForTests();
		const first = handleSessionStop({}, "/tmp", "## feat [ahead 1]\n");
		const second = handleSessionStop({}, "/tmp", "## feat [ahead 1]\n");
		expect(first).toBeDefined();
		expect(second).toBeUndefined();
	});
});

describe("integration temp git repo", () => {
	const gitOk = Bun.which("git");
	const dir = mkdtempSync(join(tmpdir(), "unpushed-adv-"));

	afterAll(() => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test.skipIf(!gitOk)("session_stop on dirty repo advises once", () => {
		resetUnpushedAdvisoryForTests();
		const run = (args: string[]) =>
			Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
		run(["init", "-b", "topic"]);
		run(["config", "user.email", "t@t.test"]);
		run(["config", "user.name", "t"]);
		writeFileSync(join(dir, "a.txt"), "one\n");
		run(["add", "a.txt"]);
		run(["commit", "-m", "c1"]);
		writeFileSync(join(dir, "a.txt"), "two\n");

		expect(hasGitDir(dir)).toBe(true);

		const handlers: Record<string, Array<(e: unknown, ctx?: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (e: string, h: (ev: unknown, ctx?: unknown) => unknown) => {
				(handlers[e] ??= []).push(h);
			},
		};
		unpushedWorkAdvisory(fakePi as never);

		const result = handlers.session_stop![0]!({}, { cwd: dir });
		expect(result).toEqual(
			expect.objectContaining({
				continue: true,
				additionalContext: expect.stringContaining("topic"),
			}),
		);

		const again = handlers.session_stop![0]!({}, { cwd: dir });
		expect(again).toBeUndefined();

		handlers.turn_start![0]!({});
		const afterTurn = handlers.session_stop![0]!({}, { cwd: dir });
		expect(afterTurn).toBeDefined();
	});
});
