import { afterEach, describe, expect, test } from "bun:test";

import bdCloseGate, {
	type BdShowRun,
	decideBdClose,
	denyReason,
	extractCommand,
	findCloseInvocations,
	gateIdsAmong,
	setBdShowRunForTests,
	tokenize,
} from "./bd-close-gate.ts";

/** Shapes recorded from bd 1.1.2 `bd show --json`. */
function row(id: string, issueType: string): Record<string, unknown> {
	return { id, title: `t ${id}`, status: "open", priority: 2, issue_type: issueType };
}

type Call = { argv: string[]; cwd: string };

/** A fake `bd show` over a fixed id -> issue_type table, recording every call. */
function fakeBd(
	table: Record<string, string>,
	calls: Call[] = [],
): { run: BdShowRun; calls: Call[] } {
	const run: BdShowRun = (argv, cwd) => {
		calls.push({ argv, cwd });
		const ids = argv.slice(argv.indexOf("show") + 1).filter((a) => !a.startsWith("--"));
		const found = ids.filter((id) => id in table);
		if (found.length === 0) {
			return {
				exitCode: 1,
				stdout: JSON.stringify({ error: "no issues found matching the provided IDs" }),
			};
		}
		return {
			exitCode: 0,
			stdout: JSON.stringify(found.map((id) => row(id, table[id] as string))),
		};
	};
	return { run, calls };
}

afterEach(() => {
	setBdShowRunForTests(null);
});

describe("extractCommand", () => {
	test("reads command then cmd", () => {
		expect(extractCommand({ command: "bd close x-1" })).toBe("bd close x-1");
		expect(extractCommand({ cmd: "bd close x-1" })).toBe("bd close x-1");
		expect(extractCommand({})).toBe("");
	});
});

describe("tokenize", () => {
	test("keeps a quoted reason as one token", () => {
		expect(tokenize('bd close a-1 --reason "then bd close b-2"')).toEqual([
			"bd",
			"close",
			"a-1",
			"--reason",
			"then bd close b-2",
		]);
	});

	test("separators become their own tokens", () => {
		expect(tokenize("bd close a-1 && bd close b-2")).toEqual([
			"bd",
			"close",
			"a-1",
			"&",
			"&",
			"bd",
			"close",
			"b-2",
		]);
	});

	test("a here-document body is data, not commands", () => {
		const command = "git commit -F - <<'EOF'\nfix: x\n\nrun bd close a-1 after\nEOF\necho done";
		expect(tokenize(command)).toEqual(["git", "commit", "-F", "-", "\n", "echo", "done"]);
	});

	test("the rest of the redirection's line stays commands", () => {
		const command = "cat <<EOF | bd close a-1\nbd close b-2\nEOF\n";
		expect(tokenize(command)).toEqual(["cat", "|", "bd", "close", "a-1", "\n"]);
	});

	test("<<- strips leading tabs before matching the terminator", () => {
		expect(tokenize("cat <<-EOF\n\tbd close a-1\n\tEOF\nbd close b-2")).toEqual([
			"cat",
			"\n",
			"bd",
			"close",
			"b-2",
		]);
	});

	test("an unterminated body runs to the end", () => {
		expect(tokenize("cat <<EOF\nbd close a-1")).toEqual(["cat", "\n"]);
	});

	test("a here-string is not a here-document", () => {
		expect(tokenize("bd close a-1 <<< x")).toEqual(["bd", "close", "a-1", "<<<", "x"]);
	});
});

describe("findCloseInvocations", () => {
	test("plain close", () => {
		expect(findCloseInvocations("bd close bdp-47b")).toEqual([{ ids: ["bdp-47b"], dbArgs: [] }]);
	});

	test("multiple ids in one close", () => {
		expect(findCloseInvocations("bd close bdp-1a bdp-2b bdp-3c --reason done")).toEqual([
			{ ids: ["bdp-1a", "bdp-2b", "bdp-3c"], dbArgs: [] },
		]);
	});

	test("done is an alias for close", () => {
		expect(findCloseInvocations("bd done bdp-47b")).toEqual([{ ids: ["bdp-47b"], dbArgs: [] }]);
	});

	test("-C before the verb is captured as a db selector", () => {
		expect(findCloseInvocations("bd -C /repo close bdp-47b")).toEqual([
			{ ids: ["bdp-47b"], dbArgs: ["-C", "/repo"] },
		]);
	});

	test("db selectors after the verb, long and = forms", () => {
		expect(findCloseInvocations("bd close bdp-47b --db=/tmp/x.db --global")).toEqual([
			{ ids: ["bdp-47b"], dbArgs: ["--db=/tmp/x.db", "--global"] },
		]);
		expect(findCloseInvocations("bd close bdp-47b --directory /repo")).toEqual([
			{ ids: ["bdp-47b"], dbArgs: ["--directory", "/repo"] },
		]);
	});

	test("a value flag never contributes its value as an id", () => {
		expect(findCloseInvocations("bd close bdp-47b --reason gate-done")).toEqual([
			{ ids: ["bdp-47b"], dbArgs: [] },
		]);
		expect(findCloseInvocations("bd close bdp-47b -r some-reason --session s-1")).toEqual([
			{ ids: ["bdp-47b"], dbArgs: [] },
		]);
	});

	test("boolean close flags pass through", () => {
		expect(findCloseInvocations("bd close bdp-47b --force --suggest-next")).toEqual([
			{ ids: ["bdp-47b"], dbArgs: [] },
		]);
	});

	test("two invocations chained", () => {
		expect(findCloseInvocations("bd close a-1 && bd -C /r close b-2")).toEqual([
			{ ids: ["a-1"], dbArgs: [] },
			{ ids: ["b-2"], dbArgs: ["-C", "/r"] },
		]);
	});

	test("other bd verbs are not close", () => {
		for (const cmd of [
			"bd show bdp-47b",
			"bd gate resolve bdp-47b",
			"bd gate check",
			"bd list --json",
			"bd update bdp-47b --status open",
			"git commit -m 'close bdp-47b'",
		]) {
			expect(findCloseInvocations(cmd)).toEqual([]);
		}
	});

	test("a quoted close inside a reason is not a second invocation", () => {
		expect(findCloseInvocations('bd close a-1 --reason "do not bd close b-2"')).toEqual([
			{ ids: ["a-1"], dbArgs: [] },
		]);
	});

	test("no literal id: close with a variable, or with none at all", () => {
		expect(findCloseInvocations("bd close $GATE_ID")).toEqual([{ ids: [], dbArgs: [] }]);
		expect(findCloseInvocations("bd close --reason done")).toEqual([{ ids: [], dbArgs: [] }]);
	});
});

describe("gateIdsAmong", () => {
	test("finds the gate among mixed types", () => {
		const { run } = fakeBd({ "bdp-1a": "task", "bdp-2b": "gate", "bdp-3c": "epic" });
		setBdShowRunForTests(run);
		expect(gateIdsAmong(["bdp-1a", "bdp-2b", "bdp-3c"])).toEqual(["bdp-2b"]);
	});

	test("close decisions use the selected database rather than a same-id local bead", () => {
		setBdShowRunForTests((argv, cwd) => {
			let database = cwd;
			for (let i = 1; i < argv.indexOf("show"); i++) {
				const arg = argv[i] as string;
				if (["-C", "--directory", "--db"].includes(arg)) database = argv[++i] as string;
				else if (arg.startsWith("--db=")) database = arg.slice("--db=".length);
			}
			return { exitCode: 0, stdout: JSON.stringify([row("bdp-1a", database === "/gates" ? "gate" : "task")]) };
		});
		expect(decideBdClose("bd close bdp-1a", "/tasks")).toBeUndefined();
		expect(decideBdClose("bd close bdp-1a", "/gates")?.block).toBe(true);
		for (const command of [
			"bd -C /gates close bdp-1a",
			"bd --actor test --db=/gates close bdp-1a",
			"bd close bdp-1a --directory /gates",
			"echo bd close bdp-1a; env MODE=test command bd --db /gates done bdp-1a",
			"sudo -u user bd --db /gates close bdp-1a",
		]) expect(decideBdClose(command, "/tasks")?.block).toBe(true);
		expect(decideBdClose("bd --db /tasks close bdp-1a", "/gates")).toBeUndefined();
	});

	test("no ids means no spawn", () => {
		const { run, calls } = fakeBd({});
		setBdShowRunForTests(run);
		expect(gateIdsAmong([])).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("non-zero exit fails open", () => {
		setBdShowRunForTests(() => ({ exitCode: 1, stdout: "" }));
		expect(gateIdsAmong(["bdp-1a"])).toEqual([]);
	});

	test("unparseable stdout reports uncertainty", () => {
		setBdShowRunForTests(() => ({ exitCode: 0, stdout: "bd: command not found" }));
		expect(() => gateIdsAmong(["bdp-1a"])).toThrow();
	});

	test("the error object shape reports uncertainty", () => {
		setBdShowRunForTests(() => ({
			exitCode: 0,
			stdout: JSON.stringify({ error: "no issues found", schema_version: 1 }),
		}));
		expect(() => gateIdsAmong(["bdp-1a"])).toThrow();
	});

	test("a throwing seam is not swallowed here", () => {
		setBdShowRunForTests(() => {
			throw new Error("spawn failed");
		});
		expect(() => gateIdsAmong(["bdp-1a"])).toThrow();
	});
});

describe("decideBdClose", () => {
	test("blocks a gate id", () => {
		const { run } = fakeBd({ "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		const decision = decideBdClose("bd close bdp-2b --reason approved");
		expect(decision).toEqual(
			expect.objectContaining({ block: true, reason: expect.stringContaining("bdp-2b") }),
		);
		expect(decision?.reason).toContain("bd gate check");
		expect(decision?.reason).toContain("bd gate resolve");
	});

	test("blocks when a gate hides among ordinary ids", () => {
		const { run } = fakeBd({ "bdp-1a": "task", "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		expect(decideBdClose("bd close bdp-1a bdp-2b")?.block).toBe(true);
	});

	test("blocks even with --force", () => {
		const { run } = fakeBd({ "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		expect(decideBdClose("bd close bdp-2b --force")?.block).toBe(true);
		expect(decideBdClose("bd close bdp-2b -f")?.block).toBe(true);
	});

	test("blocks the second of two chained closes", () => {
		const { run } = fakeBd({ "bdp-1a": "task", "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		expect(decideBdClose("bd close bdp-1a && bd close bdp-2b")?.block).toBe(true);
	});

	test("names every gate once", () => {
		const { run } = fakeBd({ "bdp-2b": "gate", "bdp-3c": "gate" });
		setBdShowRunForTests(run);
		const reason = decideBdClose("bd close bdp-2b bdp-3c && bd close bdp-2b")?.reason ?? "";
		expect(reason).toContain("bdp-2b, bdp-3c");
	});

	test("allows an ordinary bead", () => {
		const { run } = fakeBd({ "bdp-1a": "task" });
		setBdShowRunForTests(run);
		expect(decideBdClose("bd close bdp-1a --reason done")).toBeUndefined();
	});

	test("allows the sanctioned resolution sequence", () => {
		const { run, calls } = fakeBd({ "bdp-2b": "gate", "bdp-9z": "task" });
		setBdShowRunForTests(run);
		expect(decideBdClose("bd gate resolve bdp-2b")).toBeUndefined();
		expect(decideBdClose("bd gate check")).toBeUndefined();
		expect(calls).toEqual([]);
		expect(decideBdClose("bd close bdp-9z --reason 'gate answered'")).toBeUndefined();
	});


	test("mentions never query gates but a following real close still does", () => {
		const { run, calls } = fakeBd({ "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		for (const command of [
			"echo bd close bdp-2b",
			"printf '%s' bd close bdp-2b",
			"env printf '%s' bd close bdp-2b",
			"command echo bd close bdp-2b",
		]) expect(decideBdClose(command)).toBeUndefined();
		expect(calls).toEqual([]);
		expect(decideBdClose("echo bd close bdp-2b && command bd close bdp-2b")?.block).toBe(true);
	});
	test("prefilter keeps unrelated commands away from the seam", () => {
		const { run, calls } = fakeBd({ "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		for (const cmd of ["git status", "bd ready --json", "echo close"]) {
			expect(decideBdClose(cmd)).toBeUndefined();
		}
		expect(calls).toEqual([]);
	});

	test("fails open when the database cannot answer", () => {
		setBdShowRunForTests(() => ({ exitCode: 1, stdout: "" }));
		expect(decideBdClose("bd close bdp-2b")).toBeUndefined();
	});
});

describe("denyReason", () => {
	test("names the gates and both resolution paths", () => {
		const reason = denyReason(["g-1", "g-2"]);
		expect(reason).toContain("g-1, g-2");
		expect(reason).toContain("bd gate resolve");
		expect(reason).toContain("bd gate check");
		expect(reason).toContain("--force");
	});
});

describe("integration", () => {
	function register(): Array<(e: unknown) => unknown> {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			zod: {},
			registerTool: () => {},
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		bdCloseGate(fakePi as never);
		return handlers.tool_call as Array<(e: unknown) => unknown>;
	}

	test("blocks gate-closing bash, allows the rest", () => {
		const { run } = fakeBd({ "bdp-2b": "gate", "bdp-1a": "task" });
		setBdShowRunForTests(run);
		const [handler] = register();

		expect(
			handler?.({ toolName: "bash", toolCallId: "c1", input: { command: "bd close bdp-2b" } }),
		).toEqual(expect.objectContaining({ block: true }));
		expect(
			handler?.({ toolName: "bash", toolCallId: "c2", input: { command: "bd close bdp-1a" } }),
		).toBeUndefined();
	});

	test("handler decisions use the bash cwd rather than the session database", () => {
		setBdShowRunForTests((_argv, cwd) => ({
			exitCode: 0,
			stdout: JSON.stringify([row("bdp-2b", cwd === "/other/repo" ? "gate" : "task")]),
		}));
		const [handler] = register();
		expect(handler?.({
			toolName: "bash",
			toolCallId: "c6",
			input: { command: "bd close bdp-2b", cwd: "/other/repo" },
		})).toEqual(expect.objectContaining({ block: true }));
		expect(handler?.({
			toolName: "bash",
			toolCallId: "c7",
			input: { command: "bd close bdp-2b" },
		})).toBeUndefined();
	});

	test("ignores non-bash tools and empty input", () => {
		const { run, calls } = fakeBd({ "bdp-2b": "gate" });
		setBdShowRunForTests(run);
		const [handler] = register();

		expect(
			handler?.({ toolName: "edit", toolCallId: "c3", input: { command: "bd close bdp-2b" } }),
		).toBeUndefined();
		expect(handler?.({ toolName: "bash", toolCallId: "c4", input: {} })).toBeUndefined();
		expect(calls).toEqual([]);
	});

	test("a throwing seam allows the call instead of taking bash down", () => {
		setBdShowRunForTests(() => {
			throw new Error("spawn failed");
		});
		const [handler] = register();
		expect(
			handler?.({ toolName: "bash", toolCallId: "c5", input: { command: "bd close bdp-2b" } }),
		).toBeUndefined();
	});
});
