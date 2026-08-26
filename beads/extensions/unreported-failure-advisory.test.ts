import { afterEach, describe, expect, test } from "bun:test";

import unreportedFailureAdvisory, {
	bugTexts,
	checkLabel,
	failureSignals,
	formatUnreportedAdvisory,
	resetUnreportedFailureAdvisoryForTests,
	signalSubjects,
	unreportedFailures,
} from "./unreported-failure-advisory.ts";

/** `bun test` on a suite with one red test, verbatim down to the trailing notice. */
const BUN_FAIL = [
	"src/parse.test.ts:",
	"(fail) parse > rejects an empty tag [0.42ms]",
	"",
	" 12 pass",
	" 1 fail",
	" 3 expect() calls",
	"Ran 13 tests across 1 files. [86.00ms]",
	"",
	"Command exited with code 1",
].join("\n");

/** The same suite, green. Every failure word in it is a zero. */
const BUN_CLEAN = [" 10 pass", " 0 fail", " 27 expect() calls", "Ran 10 tests across 3 files. [120.00ms]"].join("\n");

/** `tsc --noEmit`, in both diagnostic spellings it prints. */
const TSC_FAIL = [
	"src/failure.ts(41,17): error TS2345: Argument of type 'string[]' is not assignable to parameter of type 'string'.",
	"src/failure.ts:88:9 - error TS2532: Object is possibly 'undefined'.",
	"Found 2 errors in 1 file.",
	"",
	"Command exited with code 2",
].join("\n");

/** `pytest -q`, whose banner rows and summary row both mention failure. */
const PYTEST_FAIL = [
	"=================================== FAILURES ===================================",
	"____________________________ test_expired_token ________________________________",
	"E       assert 401 == 200",
	"=========================== short test summary info ============================",
	"FAILED tests/test_auth.py::test_expired_token - assert 401 == 200",
	"========================= 1 failed, 12 passed in 0.42s =========================",
].join("\n");

/** `go test ./...`, which reports the symbol and then the package. */
const GO_FAIL = [
	"--- FAIL: TestResolveQueue (0.00s)",
	"    queue_test.go:42: got 3 want 4",
	"FAIL",
	"FAIL\texample.com/queue\t0.312s",
	"",
	"Command exited with code 1",
].join("\n");

/** A green suite whose subject logs at ERROR level and counts its own retries. */
const PY_LOGGING_CLEAN = [
	"ERROR:root:retry 1 of 3 failed to connect, backing off",
	"tests/test_client.py .......                                              [100%]",
	"============================== 7 passed in 0.31s ===============================",
].join("\n");

afterEach(() => {
	resetUnreportedFailureAdvisoryForTests();
});

describe("failureSignals", () => {
	test("a bun run reports its count and its exit code", () => {
		expect(failureSignals(BUN_FAIL)).toEqual(["1 failed", "exit code 1"]);
	});

	test("a clean run says nothing: every count in it is zero", () => {
		expect(failureSignals(BUN_CLEAN)).toEqual([]);
	});

	test("tsc keeps the file next to the code, in both spellings", () => {
		expect(failureSignals(TSC_FAIL)).toEqual([
			"src/failure.ts error TS2345",
			"src/failure.ts error TS2532",
			"found 2 errors",
			"exit code 2",
		]);
	});

	test("a bare diagnostic with no file position keeps the code alone", () => {
		expect(failureSignals("error TS2551: Property 'lenght' does not exist.")).toEqual(["error TS2551"]);
	});

	test("pytest's FAILED row survives whole, and its banner rows do not fire", () => {
		const signals = failureSignals(PYTEST_FAIL);
		expect(signals).toEqual(["FAILED tests/test_auth.py::test_expired_token - assert 401 == 200", "1 failed"]);
		expect(signals.some(signal => signal.includes("FAILURES ==="))).toBe(false);
	});

	test("go's failing symbol and package are both kept, and the bare FAIL collapses", () => {
		expect(failureSignals(GO_FAIL)).toEqual([
			"--- FAIL: TestResolveQueue (0.00s)",
			"FAIL",
			"FAIL example.com/queue 0.312s",
			"exit code 1",
		]);
	});

	test("the word fail in prose is not a failure", () => {
		expect(failureSignals("The retry path can fail when the socket closes, so callers must handle it.")).toEqual([]);
	});

	test("zero failures is not a failure, in either spelling", () => {
		expect(failureSignals("1 file checked, 0 failures")).toEqual([]);
		expect(failureSignals('<testsuite tests="9" failures="0">')).toEqual([]);
		expect(failureSignals("Found 0 errors. Watching for file changes.")).toEqual([]);
	});

	test("a zero exit code is a success, however it is spelled", () => {
		expect(failureSignals("Command exited with code 0")).toEqual([]);
		expect(failureSignals("exit code: 0")).toEqual([]);
	});

	test("a non-zero exit code fires in every spelling, including a signal death", () => {
		expect(failureSignals("exit code: 2")).toEqual(["exit code 2"]);
		expect(failureSignals("just: error: Recipe `test` failed with exit status 1")).toContain("exit code 1");
		expect(failureSignals("Command exited with code -6")).toEqual(["exit code -6"]);
	});

	test("a log record from a green suite is not the runner's tally", () => {
		expect(failureSignals(PY_LOGGING_CLEAN)).toEqual([]);
	});

	test("ERROR:root: is python logging; ERROR: is a failure line", () => {
		expect(failureSignals("ERROR:root:cache miss")).toEqual([]);
		expect(failureSignals("ERROR: Cannot find module 'node:sqlite'")).toEqual([
			"ERROR: Cannot find module 'node:sqlite'",
		]);
	});

	test("lowercase counts still need a number: `failing` alone is prose", () => {
		expect(failureSignals("the check is failing on main too")).toEqual([]);
	});

	test("the signal list is capped, so one broken suite cannot fill the advisory", () => {
		const many = Array.from({ length: 20 }, (_, i) => `FAILED tests/test_${i}.py::test_case`).join("\n");
		expect(failureSignals(many)).toHaveLength(6);
	});

	test("a runaway line is truncated rather than dropped", () => {
		const signals = failureSignals(`FAILED ${"x".repeat(400)}`);
		expect(signals).toHaveLength(1);
		expect(signals[0]!.length).toBe(120);
	});
});

describe("checkLabel", () => {
	test("the check runners a repository actually uses are recognised", () => {
		expect(checkLabel("bun test extensions/")).toBe("bun test");
		expect(checkLabel("bun run typecheck")).toBe("bun run typecheck");
		expect(checkLabel("cd api && uv run pytest -q")).toBe("uv run pytest");
		expect(checkLabel("cargo clippy --all-targets")).toBe("cargo clippy");
		expect(checkLabel("go test ./...")).toBe("go test");
		expect(checkLabel("npx tsc --noEmit")).toBe("npx tsc");
		expect(checkLabel("just lint")).toBe("just lint");
	});

	test("reading output is not running a check", () => {
		expect(checkLabel("cat build.log")).toBeUndefined();
		expect(checkLabel("bd list --type bug --json")).toBeUndefined();
		expect(checkLabel("git log --oneline -20")).toBeUndefined();
		expect(checkLabel("rm -rf node_modules")).toBeUndefined();
	});

	test("a word that merely contains a runner name is not that runner", () => {
		expect(checkLabel("read tsconfig.json")).toBeUndefined();
		expect(checkLabel("cmake --build .")).toBeUndefined();
	});
});

describe("signalSubjects", () => {
	test("a path yields both itself and its basename, so either title matches", () => {
		expect(signalSubjects("FAIL src/parse.test.ts")).toEqual(["src/parse.test.ts", "parse.test.ts"]);
	});

	test("a diagnostic code and a test symbol are subjects", () => {
		expect(signalSubjects("src/failure.ts error TS2345")).toContain("ts2345");
		expect(signalSubjects("--- FAIL: TestResolveQueue (0.00s)")).toEqual(["testresolvequeue"]);
		expect(signalSubjects("FAILED tests/test_auth.py::test_expired_token")).toContain("test_expired_token");
	});

	test("a version or a duration is not a path", () => {
		expect(signalSubjects("FAIL took 0.312s after 1.2")).toEqual([]);
	});

	test("a count and an exit code name nothing at all", () => {
		expect(signalSubjects("1 failed")).toEqual([]);
		expect(signalSubjects("exit code 1")).toEqual([]);
	});
});

describe("unreportedFailures", () => {
	const observed = ["src/failure.ts error TS2345", "FAILED tests/test_auth.py::test_expired_token", "exit code 1"];

	test("with no bug bead filed, everything observed is unreported", () => {
		expect(unreportedFailures(observed, [])).toEqual(observed);
	});

	test("a bead whose title names the file discharges that failure only", () => {
		const filed = ["src/failure.ts does not typecheck on main"];
		expect(unreportedFailures(observed, filed)).toEqual(["FAILED tests/test_auth.py::test_expired_token"]);
	});

	test("the description counts as much as the title", () => {
		const filed = ["typecheck is red", "auth suite is red: test_expired_token asserts 401"];
		expect(unreportedFailures(["FAILED tests/test_auth.py::test_expired_token"], filed)).toEqual([]);
	});

	test("a bead naming only the basename still records the failure", () => {
		expect(unreportedFailures(["FAIL src/parse.test.ts"], ["parse.test.ts is red since the rename"])).toEqual([]);
	});

	test("matching ignores case in both directions", () => {
		expect(unreportedFailures(["src/x.ts error TS2345"], ["TS2345 in SRC/X.TS"])).toEqual([]);
	});

	test("a subject-less signal is discharged by any bug bead", () => {
		expect(unreportedFailures(["exit code 1", "3 failed"], ["something unrelated is broken"])).toEqual([]);
	});

	test("a subject-less signal alone still reports when nothing was filed", () => {
		expect(unreportedFailures(["exit code 1"], [])).toEqual(["exit code 1"]);
	});

	test("an empty bead text cannot discharge anything", () => {
		expect(unreportedFailures(["exit code 1"], ["", "   "])).toEqual(["exit code 1"]);
	});

	test("duplicates collapse", () => {
		expect(unreportedFailures(["1 failed", "1 failed"], [])).toEqual(["1 failed"]);
	});

	test("nothing observed is nothing to report", () => {
		expect(unreportedFailures([], [])).toEqual([]);
	});
});

describe("bugTexts", () => {
	const bug = {
		id: "beads-a1",
		title: "typecheck fails in src/foo.ts",
		description: "error TS2345 in src/foo.ts blocks the build",
		issue_type: "bug",
	};

	test("the BD_JSON_ENVELOPE wrapper is unwrapped", () => {
		expect(bugTexts(JSON.stringify({ data: [bug], schema_version: 1 }))).toEqual([
			"typecheck fails in src/foo.ts error TS2345 in src/foo.ts blocks the build",
		]);
	});

	test("a bare --json array passes through, and bd's human preamble is ignored", () => {
		expect(bugTexts(`Listing bugs...\n${JSON.stringify([bug])}`)).toHaveLength(1);
	});

	test("a bead with no description is its title", () => {
		expect(bugTexts(JSON.stringify([{ id: "beads-a2", title: "flaky worker" }]))).toEqual(["flaky worker"]);
	});

	test("an empty store is an empty list, not a failure to read", () => {
		expect(bugTexts("[]")).toEqual([]);
	});

	test("an unreadable store is undefined, so the advisory can stay silent", () => {
		expect(bugTexts("")).toBeUndefined();
		expect(bugTexts("Error: no beads database found")).toBeUndefined();
		expect(bugTexts(JSON.stringify({ data: "not a list", schema_version: 1 }))).toBeUndefined();
	});

	test("rows that are not beads are skipped rather than crashing the read", () => {
		expect(bugTexts(JSON.stringify([null, 7, { id: "x" }, bug]))).toHaveLength(1);
	});
});

describe("formatUnreportedAdvisory", () => {
	const checks = new Map([
		["src/failure.ts error TS2345", "bun run typecheck"],
		["1 failed", "bun test"],
	]);

	test("names each failure with the check that produced it", () => {
		const text = formatUnreportedAdvisory(["src/failure.ts error TS2345", "1 failed"], checks);
		expect(text).toContain("- src/failure.ts error TS2345 (bun run typecheck)");
		expect(text).toContain("- 1 failed (bun test)");
		expect(text).toContain('bd create "<what fails, where>" -t bug');
		expect(text).toContain("unassigned");
	});

	test("a signal with no known check is still listed", () => {
		expect(formatUnreportedAdvisory(["exit code 1"], new Map())).toContain("- exit code 1\n");
	});

	test("the list is capped and the remainder counted", () => {
		const many = Array.from({ length: 9 }, (_, i) => `FAILED case ${i}`);
		const text = formatUnreportedAdvisory(many, new Map());
		expect(text).toContain("- ...and 3 more");
		expect(text).not.toContain("FAILED case 6");
	});
});

describe("integration", () => {
	/** Collect handlers the way the runtime would, then drive them directly. */
	const wire = () => {
		const handlers: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
		const sent: Array<{ customType?: string; content: string }> = [];
		const errors: string[] = [];
		const fakePi = {
			zod: {},
			registerTool: () => {},
			sendMessage: (m: { customType?: string; content: string }) => sent.push(m),
			logger: { error: (message: string) => errors.push(message), info: () => {} },
			on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		unreportedFailureAdvisory(fakePi as never);
		return { handlers, sent, errors };
	};

	const ctx = { cwd: "/nonexistent-repo", sessionManager: { getSessionId: () => "s1" } };

	const result = (command: string, text: string, details?: unknown) => ({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "c1",
		isError: false,
		input: { command },
		content: [{ type: "text", text }],
		details,
	});

	test("registers exactly the three boundaries it needs", () => {
		const { handlers } = wire();
		expect(Object.keys(handlers).sort()).toEqual(["session_shutdown", "session_start", "tool_result"]);
	});

	test("a failing check result is never patched and never blocked", () => {
		const { handlers } = wire();
		expect(handlers.tool_result![0]!(result("bun test", BUN_FAIL), ctx)).toBeUndefined();
	});

	test("a tool with no command line is ignored", () => {
		const { handlers } = wire();
		const event = { type: "tool_result", toolName: "read", toolCallId: "c1", isError: false, input: { path: "x.ts" }, content: [{ type: "text", text: BUN_FAIL }] };
		expect(handlers.tool_result![0]!(event, ctx)).toBeUndefined();
	});

	test("a malformed event cannot disturb the result", () => {
		const { handlers, errors } = wire();
		expect(handlers.tool_result![0]!({ toolName: "bash" }, undefined)).toBeUndefined();
		expect(errors).toEqual([]);
	});

	test("a repository with no .beads stays silent, however red the run was", async () => {
		const { handlers, sent, errors } = wire();
		handlers.tool_result![0]!(result("bun test", BUN_FAIL), ctx);
		handlers.tool_result![0]!(result("bun run typecheck", TSC_FAIL), ctx);
		await handlers.session_shutdown![0]!({ type: "session_shutdown" }, ctx);
		expect(sent).toEqual([]);
		expect(errors).toEqual([]);
	});

	test("a session that saw only a clean run reports nothing", async () => {
		const { handlers, sent } = wire();
		handlers.tool_result![0]!(result("bun test", BUN_CLEAN), ctx);
		await handlers.session_shutdown![0]!({ type: "session_shutdown" }, ctx);
		expect(sent).toEqual([]);
	});

	test("session_start clears what a previous session in this process saw", async () => {
		const { handlers, sent } = wire();
		handlers.tool_result![0]!(result("bun test", BUN_FAIL), ctx);
		handlers.session_start![0]!({ type: "session_start" }, ctx);
		await handlers.session_shutdown![0]!({ type: "session_shutdown" }, ctx);
		expect(sent).toEqual([]);
	});

	test("a non-zero exit in details is read even when the notice is gone", () => {
		const { handlers } = wire();
		// The text carries no verdict at all: `details.exitCode` is the only evidence.
		expect(handlers.tool_result![0]!(result("bun test", "output was spilled", { exitCode: 1 }), ctx)).toBeUndefined();
	});
});
