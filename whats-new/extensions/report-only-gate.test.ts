import { describe, expect, test } from "bun:test";

import reportOnlyGate, {
	DENY_REASON,
	armsGate,
	createState,
	decideToolCall,
	disarmsGate,
	isDependencyFile,
} from "./report-only-gate.ts";

const chain = () => new Proxy(() => chain(), { get: () => chain(), apply: () => chain() });
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
			(handlers[ev] ??= []).push(fn);
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
