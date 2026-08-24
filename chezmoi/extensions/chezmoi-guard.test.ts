import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import chezmoiGuard, {
	chezmoiStatusReport,
	considerPath,
	editedFiles,
	lexicalAbs,
	loadManaged,
	resetChezmoiGuardForTests,
	sedInplacePaths,
	seedChezmoiCacheForTests,
	setChezmoiSpawnForTests,
	setLastReminderAtForTests,
	shouldInspect,
	under,
} from "./chezmoi-guard.ts";

afterEach(() => {
	resetChezmoiGuardForTests();
});

type Handler = (event: Record<string, unknown>) => unknown;

function fakePi(): { handlers: Record<string, Handler[]>; pi: { zod: unknown; registerTool: () => void; on: (ev: string, h: Handler) => void } } {
	const handlers: Record<string, Handler[]> = {};
	const chain: Record<string, unknown> = {};
	const self = () => chain;
	chain.string = self;
	chain.optional = self;
	chain.describe = self;
	chain.object = self;
	return {
		handlers,
		pi: {
			zod: chain,
			registerTool: () => {},
			on: (ev, h) => {
				(handlers[ev] ??= []).push(h);
			},
		},
	};
}

const HOME = homedir();
const OUTSIDE = join(HOME, ".config", "omp-plugins-chezmoi-guard-test");
const CWD = join(HOME, "projects", "app");
const SOURCE = join(HOME, ".local", "share", "chezmoi");

describe("shouldInspect / under / lexicalAbs", () => {
	test("inspects home paths outside cwd", () => {
		expect(shouldInspect(OUTSIDE, CWD)).toBe(true);
	});

	test("skips paths inside cwd", () => {
		expect(shouldInspect(join(CWD, "src", "a.ts"), CWD)).toBe(false);
	});

	test("skips paths outside home", () => {
		expect(shouldInspect("/tmp/elsewhere", CWD)).toBe(false);
	});

	test("under treats identity and descendants", () => {
		expect(under(CWD, CWD)).toBe(true);
		expect(under(join(CWD, "x"), CWD)).toBe(true);
		expect(under("/tmp/x", CWD)).toBe(false);
	});

	test("lexicalAbs expands ~ and resolves relatives", () => {
		expect(lexicalAbs("~/.zshrc", CWD)).toBe(join(HOME, ".zshrc"));
		expect(lexicalAbs("foo/../bar", "/abs/cwd")).toBe("/abs/cwd/bar");
	});
});

describe("editedFiles / sedInplacePaths", () => {
	test("reads file_path then path then paths", () => {
		expect(editedFiles({ file_path: "a.ts" })).toEqual(["a.ts"]);
		expect(editedFiles({ path: "b.ts" })).toEqual(["b.ts"]);
		expect(editedFiles({ paths: ["c.ts", ""] })).toEqual(["c.ts"]);
		expect(editedFiles({})).toEqual([]);
	});

	test("extracts sed -i path tokens", () => {
		expect(sedInplacePaths("sed -i s/a/b/ ~/.zshrc")).toEqual(["s/a/b/", "~/.zshrc"]);
		expect(sedInplacePaths("echo hi")).toEqual([]);
	});
});

describe("managed-set lookup", () => {
	test("blocks managed target and names source", () => {
		seedChezmoiCacheForTests(new Set([OUTSIDE]), SOURCE);
		setChezmoiSpawnForTests((args) => {
			if (args[0] === "source-path" && args[1] === OUTSIDE) return `${SOURCE}/dot_config/file\n`;
			return "";
		});
		const decision = considerPath(OUTSIDE, CWD);
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain(OUTSIDE);
		expect(decision?.reason).toContain(`${SOURCE}/dot_config/file`);
	});

	test("allows unmanaged home path", () => {
		seedChezmoiCacheForTests(new Set([`${OUTSIDE}-other`]), SOURCE);
		expect(considerPath(OUTSIDE, CWD)).toBeUndefined();
	});

	test("allows when chezmoi spawn fails (binary missing)", () => {
		setChezmoiSpawnForTests(() => null);
		expect(loadManaged()).toBeNull();
		expect(considerPath(OUTSIDE, CWD)).toBeUndefined();
	});

	test("allows path inside source dir", () => {
		const srcFile = join(SOURCE, "dot_zshrc");
		seedChezmoiCacheForTests(new Set([join(HOME, ".zshrc")]), SOURCE);
		expect(considerPath(srcFile, CWD)).toBeUndefined();
	});
});

describe("chezmoi-guard integration", () => {
	test("blocks edit of managed target", () => {
		const { handlers, pi } = fakePi();
		seedChezmoiCacheForTests(new Set([OUTSIDE]), SOURCE);
		setChezmoiSpawnForTests((args) => {
			if (args[0] === "source-path" && args[1] === OUTSIDE) return `${SOURCE}/dot_config/file\n`;
			return SOURCE;
		});
		chezmoiGuard(pi as never);
		const out = handlers.tool_call?.[0]?.({
			toolName: "write",
			toolCallId: "t1",
			input: { path: OUTSIDE, cwd: CWD },
		});
		expect(out).toEqual(
			expect.objectContaining({
				block: true,
				reason: expect.stringContaining(`${SOURCE}/dot_config/file`),
			}),
		);
	});

	test("allows unmanaged write", () => {
		const { handlers, pi } = fakePi();
		seedChezmoiCacheForTests(new Set(), SOURCE);
		chezmoiGuard(pi as never);
		const out = handlers.tool_call?.[0]?.({
			toolName: "edit",
			toolCallId: "t2",
			input: { path: OUTSIDE, cwd: CWD },
		});
		expect(out).toBeUndefined();
	});

	test("allows when spawn reports missing binary", () => {
		const { handlers, pi } = fakePi();
		setChezmoiSpawnForTests(() => null);
		chezmoiGuard(pi as never);
		const out = handlers.tool_call?.[0]?.({
			toolName: "write",
			toolCallId: "t3",
			input: { path: OUTSIDE, cwd: CWD },
		});
		expect(out).toBeUndefined();
	});

	test("source-dir edit allows and tool_result reminder throttles", () => {
		const { handlers, pi } = fakePi();
		const srcFile = join(SOURCE, "dot_zshrc");
		seedChezmoiCacheForTests(new Set([join(HOME, ".zshrc")]), SOURCE);
		chezmoiGuard(pi as never);
		const call = handlers.tool_call?.[0]?.({
			toolName: "write",
			toolCallId: "src1",
			input: { path: srcFile, cwd: CWD },
		});
		expect(call).toBeUndefined();

		const resultEvent = {
			toolName: "write",
			toolCallId: "src1",
			content: [{ type: "text", text: "ok" }],
		};
		const first = handlers.tool_result?.[0]?.(resultEvent) as { content: Array<{ text: string }> } | undefined;
		expect(first?.content[0]?.text).toContain("Chezmoi source edited");

		handlers.tool_call?.[0]?.({
			toolName: "write",
			toolCallId: "src2",
			input: { path: srcFile, cwd: CWD },
		});
		const second = handlers.tool_result?.[0]?.({
			toolName: "write",
			toolCallId: "src2",
			content: [{ type: "text", text: "ok" }],
		});
		expect(second).toBeUndefined();

		setLastReminderAtForTests(0);
		handlers.tool_call?.[0]?.({
			toolName: "write",
			toolCallId: "src3",
			input: { path: srcFile, cwd: CWD },
		});
		const third = handlers.tool_result?.[0]?.({
			toolName: "write",
			toolCallId: "src3",
			content: [{ type: "text", text: "ok" }],
		}) as { content: Array<{ text: string }> } | undefined;
		expect(third?.content[0]?.text).toContain("Chezmoi source edited");
	});
});

describe("chezmoi_status", () => {
	test("combines status and diff", () => {
		setChezmoiSpawnForTests((args) => {
			if (args[0] === "status") return " M .zshrc";
			if (args[0] === "diff") return "1 file changed";
			return "";
		});
		const r = chezmoiStatusReport();
		expect(r.ok).toBe(true);
		expect(r.text).toContain("M .zshrc");
		expect(r.text).toContain("1 file changed");
	});

	test("registers tool", async () => {
		const captured: {
			name?: string;
			execute?: () => Promise<{ details: { ok: boolean }; content: { text: string }[] }>;
		} = {};
		const { pi } = fakePi();
		pi.registerTool = (d: Record<string, unknown>) => Object.assign(captured, d);
		setChezmoiSpawnForTests(() => "ok");
		chezmoiGuard(pi as never);
		expect(captured.name).toBe("chezmoi_status");
		const out = await captured.execute!();
		expect(out.details.ok).toBe(true);
	});
});
