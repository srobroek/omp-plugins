import { describe, expect, test } from "bun:test";

import reportOnlyGate, {
	armsGate,
	commandMutates,
	createState,
	DENY_REASON,
	decideInput,
	decideToolCall,
	disarmsGate,
	isDependencyFile,
} from "./report-only-gate.ts";

type Chain = (() => Chain) & { readonly [key: string]: Chain };
const chain = (() => chain) as Chain;
const z = new Proxy({}, { get: () => chain() }) as never;

function fakePi(): {
	handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>>;
	pi: never;
} {
	const handlers: Record<string, Array<(e: Record<string, unknown>) => unknown>> = {};
	const pi = {
		zod: z,
		registerTool: () => {},
		on: (ev: string, fn: (e: Record<string, unknown>) => unknown) => {
			const registered = handlers[ev] ?? [];
			registered.push(fn);
			handlers[ev] = registered;
		},
	};
	return { handlers, pi: pi as never };
}

function armed() {
	const state = createState();
	state.armed = true;
	return state;
}

describe("armsGate / disarmsGate", () => {
	test("arms on the skill url, its references, and the SKILL.md path", () => {
		expect(armsGate("skill://whats-new")).toBe(true);
		expect(armsGate("skill://whats-new/references/recipes.md")).toBe(true);
		expect(armsGate("/Users/x/.omp/plugins/whats-new/skills/whats-new/SKILL.md")).toBe(true);
	});

	test("ignores unrelated reads", () => {
		expect(armsGate("skill://whats-newer")).toBe(false);
		expect(armsGate("skill://dep-update")).toBe(false);
		expect(armsGate("README.md")).toBe(false);
		expect(armsGate("docs/whats-new.md")).toBe(false);
	});

	test("dep-update releases the gate", () => {
		expect(disarmsGate("skill://dep-update")).toBe(true);
		expect(disarmsGate("skill://dep-update/references/recipes.md")).toBe(true);
		expect(disarmsGate("dep-update/skills/dep-update/SKILL.md")).toBe(true);
		expect(disarmsGate("skill://whats-new")).toBe(false);
	});

	test("a /skill: input load arms and hands over without any read", () => {
		const state = createState();
		decideInput(state, "/skill:whats-newer react");
		expect(state.armed).toBe(false);
		decideInput(state, "  /skill:whats-new react 18 -> 19");
		expect(state.armed).toBe(true);
		decideInput(state, "please run /skill:dep-update");
		expect(state.armed).toBe(true);
		decideInput(state, "/skill:dep-update");
		expect(state.armed).toBe(false);
	});
});

describe("isDependencyFile", () => {
	test("matches manifests and lockfiles at any depth", () => {
		for (const path of [
			"package.json",
			"apps/web/package.json",
			"Cargo.toml",
			"crates/core/Cargo.lock",
			"pyproject.toml",
			"go.mod",
			"go.sum",
			"uv.lock",
			"bun.lock",
			"bun.lockb",
			"poetry.lock",
			"yarn.lock",
			"package-lock.json",
			"npm-shrinkwrap.json",
			"apps/web/pnpm-lock.yaml",
		]) {
			expect(isDependencyFile(path)).toBe(true);
		}
	});

	test("leaves source, docs, and lookalikes alone", () => {
		for (const path of [
			"src/index.ts",
			"REPORT.md",
			"package.json.bak",
			"tsconfig.json",
			"docs/go.mod.md",
			"locked.txt",
		]) {
			expect(isDependencyFile(path)).toBe(false);
		}
	});
});

describe("decideToolCall while unarmed", () => {
	test("allows every write and installer before the skill is read", () => {
		const state = createState();
		expect(decideToolCall(state, "write", { path: "package.json" })).toBeUndefined();
		expect(decideToolCall(state, "edit", { path: "Cargo.toml" })).toBeUndefined();
		expect(decideToolCall(state, "bash", { command: "pnpm add zod" })).toBeUndefined();
	});
});

describe("decideToolCall while armed", () => {
	test("blocks direct apply until deliberate handoff and blocks mixed-path lockfile edits", () => {
		const state = armed();
		expect(decideToolCall(state, "dep_apply", { ecosystem: "npm", name: "x", version: "1.0.0" })?.block).toBe(true);
		expect(decideToolCall(state, "edit", { paths: ["report.md", "web/pnpm-lock.yaml"] })?.block).toBe(true);
		expect(decideToolCall(state, "write", { path: "constructor" })).toBeUndefined();
		expect(decideToolCall(state, "constructor", { path: "package.json" })).toBeUndefined();
		decideToolCall(state, "read", { path: "skill://dep-update" });
		expect(decideToolCall(state, "dep_apply", {})).toBeUndefined();
	});
	test("blocks manifest and lockfile writes", () => {
		expect(decideToolCall(armed(), "write", { path: "package.json" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
		expect(decideToolCall(armed(), "edit", { path: "crates/core/Cargo.toml" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
		expect(decideToolCall(armed(), "edit", { paths: ["README.md", "uv.lock"] })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
	});

	test("blocks installer and upgrade commands", () => {
		for (const command of [
			"npm install lodash",
			"npm update",
			"pnpm add -D vitest",
			"pnpm upgrade",
			"bun add zod@latest",
			"yarn up react",
			"pip install requests",
			"pip3 install -U requests",
			"cargo add serde",
			"cargo update -p tokio",
			"cargo install cargo-audit",
			"go get golang.org/x/tools@latest",
			"uv add httpx",
			"uv pip install httpx",
			"poetry add fastapi",
			"poetry update",
			"cd repo && npm install",
		]) {
			expect(decideToolCall(armed(), "bash", { command })).toEqual({
				block: true,
				reason: DENY_REASON,
			});
		}
	});

	test("blocks the installer forms the pattern matcher missed", () => {
		for (const command of [
			"npm i lodash",
			"npm i react@latest",
			"npm ci",
			"npm --prefix /repo install",
			"/usr/local/bin/npm install",
			"pnpm i",
			"pnpm -C web add zod",
			"pnpm dlx npm-check-updates -u",
			"bun i",
			"yarn",
			"yarn --frozen-lockfile",
			"uv sync",
			"uv lock --upgrade",
			"uv lock -U",
			"uv lock -P httpx",
			"uv lock --upgrade-package=httpx",
			"uv --directory api add httpx",
			"bundle update",
			"bundle install",
			"bundle add rails",
			"gem install rails",
			"composer require vendor/pkg",
			"composer update",
			"ncu -u",
			"npx npm-check-updates -u",
			"python -m pip install requests",
			"python3.12 -m pip install -U requests",
			"poetry install",
			"sudo npm i -g typescript",
			"env CI=1 npm ci",
			"FOO=1 pnpm add zod",
			"time poetry update",
			"bash -c \"npm install x\"",
			"sh -lc 'uv sync'",
			"echo $(npm i x)",
			"echo \"$(npm i x)\"",
			"echo `pnpm add x`",
			"git status; uv add httpx",
			"cd a || pip install x",
			"cat <<EOF\n$(npm i x)\nEOF",
		]) {
			expect({ command, blocked: commandMutates(command) }).toEqual({ command, blocked: true });
		}
	});

	test("quoted data, help, lookups, and read-only subcommands stay allowed", () => {
		for (const command of [
			"echo 'see: npm install docs'",
			"echo \"cd repo && npm install\"",
			"printf '%s\\n' npm install",
			"git commit -m \"npm install lodash\"",
			"grep -rn \"pip install\" .",
			"cat <<'EOF'\nnpm install\nEOF",
			"cat <<EOF\nnpm install\nEOF",
			"uv add --help",
			"npm install -h",
			"uv lock",
			"uv tree",
			"uv pip list",
			"yarn build",
			"yarn --version",
			"command -v yarn",
			"bundle exec rake",
			"composer show",
			"ncu",
			"python -m pytest",
			"pnpm why zod",
		]) {
			expect({ command, blocked: commandMutates(command) }).toEqual({ command, blocked: false });
		}
	});

	test("ast_edit on a manifest is a write", () => {
		expect(decideToolCall(armed(), "ast_edit", { paths: ["src/", "package.json"] })).toEqual({ block: true, reason: DENY_REASON });
		expect(decideToolCall(armed(), "ast_edit", { paths: ["src/"] })).toBeUndefined();
	});

	test("allows the report itself, research commands, and unrelated builds", () => {
		expect(decideToolCall(armed(), "write", { path: "WHATS-NEW.md" })).toBeUndefined();
		expect(decideToolCall(armed(), "edit", { path: "src/index.ts" })).toBeUndefined();
		for (const command of [
			"npm view react versions --json",
			"npm run build",
			"bun test",
			"cargo build",
			"go build ./...",
			"git clone --bare https://github.com/x/y",
			"curl -s https://pypi.org/pypi/httpx/json",
			"pip download httpx",
		]) {
			expect(decideToolCall(armed(), "bash", { command })).toBeUndefined();
		}
	});

	test("reading dep-update releases the gate, whats-new re-arms it", () => {
		const state = armed();
		expect(decideToolCall(state, "read", { path: "skill://dep-update" })).toBeUndefined();
		expect(state.armed).toBe(false);
		expect(decideToolCall(state, "bash", { command: "pnpm add zod" })).toBeUndefined();

		expect(decideToolCall(state, "read", { path: "skill://whats-new" })).toBeUndefined();
		expect(state.armed).toBe(true);
		expect(decideToolCall(state, "bash", { command: "pnpm add zod" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
	});
});

describe("register", () => {
	test("arms from a skill read, then blocks", () => {
		const { handlers, pi } = fakePi();
		reportOnlyGate(pi);
		const call = handlers.tool_call?.[0];

		expect(
			call?.({ toolName: "write", toolCallId: "1", input: { path: "package.json" } }),
		).toBeUndefined();

		expect(
			call?.({ toolName: "read", toolCallId: "2", input: { path: "skill://whats-new" } }),
		).toBeUndefined();

		expect(
			call?.({ toolName: "write", toolCallId: "3", input: { path: "package.json" } }),
		).toEqual({ block: true, reason: DENY_REASON });
		expect(call?.({ toolName: "bash", toolCallId: "4", input: { command: "uv add httpx" } })).toEqual(
			{ block: true, reason: DENY_REASON },
		);
	});

	test("arms from /skill: input, then blocks", () => {
		const { handlers, pi } = fakePi();
		reportOnlyGate(pi);
		const call = handlers.tool_call?.[0];
		expect(call?.({ toolName: "bash", toolCallId: "1", input: { command: "npm i" } })).toBeUndefined();
		expect(handlers.input?.[0]?.({ type: "input", text: "/skill:whats-new zod 3 -> 4", source: "interactive" })).toBeUndefined();
		expect(call?.({ toolName: "bash", toolCallId: "2", input: { command: "npm i" } })).toEqual({ block: true, reason: DENY_REASON });
	});

	test("state is per session: session_start disarms, and a second instance starts unarmed", () => {
		const { handlers, pi } = fakePi();
		reportOnlyGate(pi);
		const call = handlers.tool_call?.[0];
		call?.({ toolName: "read", toolCallId: "1", input: { path: "skill://whats-new" } });
		expect(call?.({ toolName: "write", toolCallId: "2", input: { path: "go.mod" } })).toEqual({
			block: true,
			reason: DENY_REASON,
		});

		handlers.session_start?.[0]?.({ type: "session_start" });
		expect(
			call?.({ toolName: "write", toolCallId: "3", input: { path: "go.mod" } }),
		).toBeUndefined();

		const second = fakePi();
		reportOnlyGate(second.pi);
		expect(
			second.handlers.tool_call?.[0]?.({
				toolName: "write",
				toolCallId: "4",
				input: { path: "go.mod" },
			}),
		).toBeUndefined();
	});

	test("handler swallows throws", () => {
		const { handlers, pi } = fakePi();
		reportOnlyGate(pi);
		expect(handlers.tool_call?.[0]?.({ toolName: "write", input: null })).toBeUndefined();
	});
});
