import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, test } from "bun:test";

import preferToolsAdvisory, {
	decideSwaps,
	formatAdvisory,
	resetPreferToolsAdvisoryForTests,
} from "./prefer-tools-advisory.ts";

/** A scratch tree seeded with `files` (name -> contents) and a `.git` stop marker. */
function tree(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "prefer-tools-"));
	mkdirSync(join(dir, ".git"), { recursive: true });
	for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
	return dir;
}

const bare = tree({});

describe("npm/yarn -> bun", () => {
	const bun = tree({ "bun.lock": "" });

	test("fires on install verbs when bun owns the tree", () => {
		expect(decideSwaps("npm install", bun).map((h) => h.modern)).toEqual(["bun"]);
		expect(decideSwaps("npm i zod", bun)).toHaveLength(1);
		expect(decideSwaps("yarn add zod", bun)).toHaveLength(1);
		expect(decideSwaps("cd web && npm install", bun)).toHaveLength(1);
	});

	test("silent without a bun marker", () => {
		expect(decideSwaps("npm install", bare)).toEqual([]);
	});

	test("silent on non-install npm verbs and on npx", () => {
		expect(decideSwaps("npm run build", bun)).toEqual([]);
		expect(decideSwaps("npm view zod versions", bun)).toEqual([]);
		expect(decideSwaps("npx tsc --noEmit", bun)).toEqual([]);
	});

	test("bunfig.toml alone is enough", () => {
		expect(decideSwaps("yarn add zod", tree({ "bunfig.toml": "" }))).toHaveLength(1);
	});

	test("a package subdirectory inherits the root marker", () => {
		const root = tree({ "bun.lock": "" });
		const pkg = join(root, "packages", "web");
		mkdirSync(pkg, { recursive: true });
		expect(decideSwaps("npm install", pkg)).toHaveLength(1);
	});
});

describe("pip/poetry -> uv", () => {
	const uv = tree({ "uv.lock": "" });

	test("fires on pip and poetry when uv owns the tree", () => {
		expect(decideSwaps("pip install httpx", uv).map((h) => h.modern)).toEqual(["uv"]);
		expect(decideSwaps("pip3 install -r requirements.txt", uv)).toHaveLength(1);
		expect(decideSwaps("python -m pip install httpx", uv)).toHaveLength(1);
		expect(decideSwaps("poetry add httpx", uv)).toHaveLength(1);
		expect(decideSwaps("poetry run pytest", uv)).toHaveLength(1);
	});

	test("uv's own pip escape hatch is not the legacy tool", () => {
		expect(decideSwaps("uv pip install -r requirements.txt", uv)).toEqual([]);
	});

	test("pyproject [tool.uv] counts as configuration", () => {
		const configured = tree({ "pyproject.toml": "[project]\nname = 'x'\n\n[tool.uv]\ndev-dependencies = []\n" });
		expect(decideSwaps("pip install httpx", configured)).toHaveLength(1);
	});

	test("a pyproject without [tool.uv] is not a uv project", () => {
		expect(decideSwaps("pip install httpx", tree({ "pyproject.toml": "[project]\nname = 'x'\n" }))).toEqual(
			[],
		);
	});
});

describe("nvm/pyenv -> mise", () => {
	test("fires only with a mise config", () => {
		const mise = tree({ "mise.toml": "" });
		expect(decideSwaps("nvm use 22", mise).map((h) => h.modern)).toEqual(["mise"]);
		expect(decideSwaps("pyenv install 3.13", tree({ ".mise.toml": "" }))).toHaveLength(1);
		expect(decideSwaps("nvm use 22", bare)).toEqual([]);
	});
});

describe("make -> just", () => {
	test("fires when a justfile exists and no Makefile does", () => {
		const just = tree({ justfile: "build:\n\techo hi\n" });
		expect(decideSwaps("make build", just).map((h) => h.modern)).toEqual(["just"]);
		expect(decideSwaps("make", just)).toHaveLength(1);
	});

	test("a Makefile means make is still load-bearing", () => {
		const both = tree({ justfile: "build:\n", Makefile: "build:\n" });
		expect(decideSwaps("make build", both)).toEqual([]);
	});

	test("does not fire on other commands containing make", () => {
		const just = tree({ justfile: "build:\n" });
		expect(decideSwaps("cmake --build .", just)).toEqual([]);
		expect(decideSwaps("makeself --help", just)).toEqual([]);
	});
});

describe("formatAdvisory", () => {
	test("names the marker, the modern tool, and the replacement", () => {
		const text = formatAdvisory([
			{ id: "npm-to-bun", legacyName: "npm/yarn", modern: "bun", hint: "bun add <package>", marker: "bun.lock" },
		]);
		expect(text).toContain("bun.lock");
		expect(text).toContain("bun add <package>");
		expect(text).toContain("npm/yarn");
	});
});

describe("integration", () => {
	const wire = () => {
		const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
		preferToolsAdvisory({
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (e: Record<string, unknown>) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		} as never);
		return handlers;
	};

	beforeEach(() => resetPreferToolsAdvisoryForTests());

	test("advises on the result, never blocks, once per tree", () => {
		const handlers = wire();
		const bun = tree({ "bun.lock": "" });
		const call = handlers.tool_call![0]!;
		const done = handlers.tool_result![0]!;

		expect(call({ toolName: "bash", toolCallId: "b1", input: { command: "npm install", cwd: bun } })).toBeUndefined();
		const patched = done({
			toolName: "bash",
			toolCallId: "b1",
			content: [{ type: "text", text: "added 1 package" }],
		});
		expect(JSON.stringify(patched)).toContain("bun install");

		call({ toolName: "bash", toolCallId: "b2", input: { command: "npm install", cwd: bun } });
		expect(
			done({ toolName: "bash", toolCallId: "b2", content: [{ type: "text", text: "up to date" }] }),
		).toBeUndefined();
	});

	test("a failed run still made the tool choice", () => {
		const handlers = wire();
		const bun = tree({ "bun.lock": "" });
		handlers.tool_call![0]!({ toolName: "bash", toolCallId: "f1", input: { command: "npm install", cwd: bun } });
		const patched = handlers.tool_result![0]!({
			toolName: "bash",
			toolCallId: "f1",
			isError: true,
			content: [{ type: "text", text: "ENOENT" }],
		});
		expect(JSON.stringify(patched)).toContain("bun");
	});

	test("ignores non-bash tools and malformed events", () => {
		const handlers = wire();
		expect(
			handlers.tool_call![0]!({ toolName: "edit", toolCallId: "n1", input: { command: "npm install" } }),
		).toBeUndefined();
		expect(handlers.tool_call![0]!({ toolName: "bash", toolCallId: "n2", input: null })).toBeUndefined();
		expect(handlers.tool_result![0]!({ toolName: "bash", toolCallId: "n2" })).toBeUndefined();
	});
});
