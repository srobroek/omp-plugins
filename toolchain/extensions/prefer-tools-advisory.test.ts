import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import preferToolsAdvisory, {
	decideSwaps,
	formatAdvisory,
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
	});

	test("silent on poetry subcommands that change nothing", () => {
		for (const command of ["poetry check", "poetry show", "poetry run pytest", "poetry --version", "poetry env info"]) {
			expect({ command, hits: decideSwaps(command, uv) }).toEqual({ command, hits: [] });
		}
		for (const command of ["poetry lock", "poetry remove httpx", "poetry install", "poetry update"]) {
			expect({ command, hits: decideSwaps(command, uv).length }).toEqual({ command, hits: 1 });
		}
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

	test("silent on read-only version queries", () => {
		const mise = tree({ "mise.toml": "" });
		for (const command of [
			"pyenv which python",
			"pyenv versions",
			"pyenv local",
			"pyenv global",
			"nvm ls",
			"nvm current",
			"nvm alias default",
		]) {
			expect({ command, hits: decideSwaps(command, mise) }).toEqual({ command, hits: [] });
		}
	});

	test("fires when a version is installed or selected", () => {
		const mise = tree({ "mise.toml": "" });
		for (const command of ["pyenv local 3.13", "pyenv global 3.12", "pyenv uninstall 3.11", "nvm install", "nvm alias default 22"]) {
			expect({ command, hits: decideSwaps(command, mise).length }).toEqual({ command, hits: 1 });
		}
	});
});

describe("make -> just", () => {
	test("fires when a justfile exists and no Makefile does", () => {
		const just = tree({ justfile: "build:\n\techo hi\n" });
		expect(decideSwaps("make build", just).map((h) => h.modern)).toEqual(["just"]);
		expect(decideSwaps("make", just)).toHaveLength(1);
		expect(decideSwaps("cd sub && make -j4", just)).toHaveLength(1);
		expect(decideSwaps("FOO=1 make test", just)).toHaveLength(1);
		expect(decideSwaps("gmake test", just)).toHaveLength(1);
	});

	test("does not fire on make inside quoted arguments", () => {
		const just = tree({ justfile: "build:\n" });
		expect(
			decideSwaps(
				'bd create --type bug --title "x" --description "Implement the extractor or make the recipe refuse python"',
				just,
			),
		).toEqual([]);
		expect(decideSwaps("echo 'we make progress'", just)).toEqual([]);
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

describe("shell grammar", () => {
	const bun = tree({ "bun.lock": "" });

	test("the command word follows reserved words and chain operators", () => {
		for (const command of [
			"if true; then npm install foo; fi",
			"if npm install; then echo ok; fi",
			"for p in a b; do npm i $p; done",
			"while false; do npm install; done",
			"! npm install",
			"{ npm install; }",
			"true && npm install",
			"false || npm install",
		]) {
			expect({ command, hits: decideSwaps(command, bun).length }).toEqual({ command, hits: 1 });
		}
	});

	test("a reserved word in argument position is data", () => {
		expect(decideSwaps("echo then npm install", bun)).toEqual([]);
	});

	test("env -C / --chdir moves where the marker is read", () => {
		expect(decideSwaps(`env -C ${bare} npm install foo`, bun)).toEqual([]);
		expect(decideSwaps(`env -C ${bun} npm install foo`, bare)).toHaveLength(1);
		expect(decideSwaps(`env --chdir=${bun} npm i`, bare)).toHaveLength(1);
	});
});

describe("advisory text", () => {
	test("each swap names its own cost", () => {
		const npm = formatAdvisory(decideSwaps("npm install", tree({ "bun.lock": "" })));
		expect(npm).toContain("lockfile");
		const pyenv = formatAdvisory(decideSwaps("pyenv install 3.13", tree({ "mise.toml": "" })));
		expect(pyenv).toContain("mise");
		expect(pyenv).not.toContain("lockfile");
		const make = formatAdvisory(decideSwaps("make build", tree({ justfile: "build:\n" })));
		expect(make).toContain("justfile");
		expect(make).not.toContain("lockfile");
	});
});
describe("integration", () => {
	const wire = (cwd = bare) => {
		const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
		preferToolsAdvisory({
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (e: Record<string, unknown>, ctx: { cwd: string }) => unknown) => {
				const registered = handlers[event] ?? [];
				registered.push((e) => handler(e, { cwd }));
				handlers[event] = registered;
			},
		} as never);
		return handlers;
	};


	test("advises on each result without blocking", () => {
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
		).toBeDefined();
	});

	test("advice travels as trusted additionalContext and leaves the tool output untouched", () => {
		const handlers = wire();
		const bun = tree({ "bun.lock": "" });
		handlers.tool_call![0]!({ toolName: "bash", toolCallId: "c1", input: { command: "npm install", cwd: bun } });
		const result = handlers.tool_result![0]!({
			toolName: "bash",
			toolCallId: "c1",
			content: [{ type: "text", text: "added 1 package" }],
		}) as Record<string, unknown>;
		expect(Object.keys(result)).toEqual(["additionalContext"]);
		expect(result.additionalContext).toContain("bun install");
		expect(result.additionalContext).not.toContain("<system-reminder>");
	});

	test("a failed run gets no advice", () => {
		const handlers = wire();
		const bun = tree({ "bun.lock": "" });
		handlers.tool_call![0]!({ toolName: "bash", toolCallId: "f1", input: { command: "npm install", cwd: bun } });
		const result = handlers.tool_result![0]!({
			toolName: "bash",
			toolCallId: "f1",
			isError: true,
			content: [{ type: "text", text: "ENOENT" }],
		});
		expect(result).toBeUndefined();
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
