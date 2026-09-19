import { afterEach, describe, expect, test } from "bun:test";

import bdPoolDiscipline, {
	DECLARED_POOL_SET,
	INTEGRATION_OWNER_METADATA_KEY,
	PHASE_METADATA_KEY,
	setBdRunForTests,
} from "./bd-pool-discipline.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

type RunState = {
	pool: string | undefined;
	assignee?: string;
	setExit?: number;
	phase?: string;
	owner?: string;
	slot?: boolean;
	calls: string[][];
};

function handlers(state: RunState): { toolCall: Handler; toolResult: Handler } {
	const registered: Record<string, Handler[]> = {};
	const pi = {
		on(kind: string, handler: Handler) {
			const handlersForKind = registered[kind] ?? [];
		handlersForKind.push(handler);
		registered[kind] = handlersForKind;
		},
	};
	bdPoolDiscipline(pi as never);
	const toolCall = registered.tool_call?.[0];
	const toolResult = registered.tool_result?.[0];
	if (toolCall === undefined || toolResult === undefined) throw new Error("pool discipline handlers were not registered");
	setBdRunForTests(async (argv, _cwd, _env) => {
		state.calls.push(argv);
		const command = argv.slice(1).join(" ");
		if (command.includes("config show")) {
			return { exitCode: 0, stdout: state.pool === undefined ? JSON.stringify({ data: {} }) : JSON.stringify({ data: { "claim.pools": { value: state.pool, source: "database" } } }) };
		}
		if (command.includes("config set")) {
			if (state.setExit !== undefined) return { exitCode: state.setExit, stdout: "", stderr: "set failed" };
			state.pool = argv[argv.indexOf("claim.pools") + 1];
			return { exitCode: 0, stdout: "" };
		}
		if (argv.includes("show")) {
			const id = argv[argv.indexOf("show") + 1];
			return { exitCode: 0, stdout: JSON.stringify({ data: [{ id, assignee: state.assignee, labels: state.slot ? ["pr:merge"] : [], metadata: { ...(state.phase === undefined ? {} : { [PHASE_METADATA_KEY]: state.phase }), ...(state.owner === undefined ? {} : { [INTEGRATION_OWNER_METADATA_KEY]: state.owner }) } }] }) };
		}
		if (argv.includes("update")) return { exitCode: 0, stdout: "updated" };
		return { exitCode: 0, stdout: "" };
	});
	return { toolCall, toolResult };
}

function call(command: string, toolCallId = "call-1"): Record<string, unknown> {
	return { toolName: "bash", toolCallId, input: { command, cwd: "/repo", env: {} } };
}

function result(toolCallId: string, text: string): Record<string, unknown> {
	return { toolCallId, content: [{ type: "text", text }], isError: false, details: { exitCode: 0 } };
}

afterEach(() => setBdRunForTests(null));

describe("claim pool precondition", () => {
	test("refuses an unset pool set before the claim can run", async () => {
		const state: RunState = { pool: undefined, assignee: "pool:orc-reviewer", setExit: 1, calls: [] };
		const { toolCall } = handlers(state);
		const decision = await toolCall(call("bd update bead-1 --claim"), { cwd: "/repo" });
		// The store path comes from the environment, so assert the shape rather than
		// one machine's path: a hardcoded home directory fails everywhere else.
		expect(decision).toEqual({ block: true, reason: expect.stringContaining("key claim.pools") });
		expect(state.calls.some(argv => argv.includes("--claim"))).toBe(false);
	});

	test("allows the claim when bd reports a database pool set", async () => {
		const state: RunState = { pool: DECLARED_POOL_SET, assignee: "pool:orc-reviewer", calls: [] };
		const { toolCall } = handlers(state);
		expect(await toolCall(call("bd update bead-1 --claim"), { cwd: "/repo" })).toBeUndefined();
		expect(state.calls[1]).toEqual(["bd", "config", "show", "--json"]);
	});

	test("sets and reads back the declared aliases when the database value is absent", async () => {
		const state: RunState = { pool: undefined, assignee: "pool:orc-reviewer", calls: [] };
		const { toolCall } = handlers(state);
		expect(await toolCall(call("bd update bead-1 --claim"), { cwd: "/repo" })).toBeUndefined();
		expect(state.calls.some(argv => argv.includes("config") && argv.includes("set"))).toBe(true);
		expect(state.pool).toBe(DECLARED_POOL_SET);
		expect(state.calls.filter(argv => argv.includes("config") && argv.includes("show")).length).toBe(2);
	});
});

test("does not preflight a claim for a real assignee", async () => {
		const state: RunState = { pool: undefined, assignee: "omp/other", setExit: 1, calls: [] };
		const { toolCall } = handlers(state);
		expect(await toolCall(call("bd update bead-1 --claim"), { cwd: "/repo" })).toBeUndefined();
		expect(state.calls).toHaveLength(1);
	});

describe("reclaim phase restoration", () => {
	test("re-stamps the phase alias recorded on a reclaimed bead", async () => {
		const state: RunState = { pool: DECLARED_POOL_SET, phase: "pool:orc-reviewer", calls: [] };
		const { toolCall, toolResult } = handlers(state);
		expect(await toolCall(call("bd reclaim --older-than 0s --id bead-1"))).toBeUndefined();
		await toolResult(result("call-1", '{"data":[{"id":"bead-1"}]}'));
		expect(state.calls).toContainEqual(["bd", "show", "bead-1", "--json"]);
		expect(state.calls).toContainEqual(["bd", "update", "bead-1", "--assignee", "pool:orc-reviewer", "--json"]);
	});

	test("restores a reclaimed merge slot to its integration owner", async () => {
		const state: RunState = { pool: DECLARED_POOL_SET, owner: "omp/shepherd", slot: true, calls: [] };
		const { toolCall, toolResult } = handlers(state);
		await toolCall(call("bd reclaim --older-than 0s --id bead-1"));
		await toolResult(result("call-1", '{"data":[{"id":"bead-1"}]}'));
		expect(state.calls).toContainEqual(["bd", "update", "bead-1", "--assignee", "omp/shepherd", "--json"]);
	});

	test("reports a reclaimed merge slot with no recorded owner", async () => {
		const state: RunState = { pool: DECLARED_POOL_SET, slot: true, calls: [] };
		const { toolCall, toolResult } = handlers(state);
		await toolCall(call("bd reclaim --older-than 0s --id bead-1"));
		const advisory = await toolResult(result("call-1", '{"data":[{"id":"bead-1"}]}')) as { content: Array<{ text?: string }> };
		expect(advisory.content[0]?.text).toContain("no recorded `integration_owner` metadata");
		expect(state.calls.some(argv => argv.includes("--assignee"))).toBe(false);
	});

	test("reports a reclaimed work bead with no recorded phase instead of leaving it silent", async () => {
		const state: RunState = { pool: DECLARED_POOL_SET, calls: [] };
		const { toolCall, toolResult } = handlers(state);
		await toolCall(call("bd reclaim --older-than 0s --id bead-1"));
		const advisory = await toolResult(result("call-1", '{"data":[{"id":"bead-1"}]}')) as { content: Array<{ text?: string }> };
		expect(advisory.content[0]?.text).toContain("no recorded `phase` metadata");
		expect(state.calls.some(argv => argv.includes("--assignee"))).toBe(false);
	});
});
