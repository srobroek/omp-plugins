import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashGates from "./bash-gates.ts";
import { setBdShowRunForTests } from "./bd-close-gate.ts";
import { blockReason, classify, parse, settingsEnabled } from "./shell-command.ts";

type Handler = (event: unknown, context?: unknown) => unknown;

function registeredBashHandler(): Handler {
	const handlers: Handler[] = [];
	bashGates({
		on(event: string, handler: Handler) {
			if (event === "tool_call") handlers.push(handler);
		},
		sendMessage() {},
	} as never);
	const handler = handlers[0];
	if (handler === undefined) throw new Error("bash gate did not register a tool_call handler");
	return handler;
}

const context = { cwd: "/tmp" };

describe("shared beads shell parser", () => {
	test("keeps quoted prose and quoted heredoc bodies out of command positions", () => {
		expect(classify(parse("echo 'bd close x'"))).toBe("read-only");
		expect(classify(parse("cat <<'EOF'\nbd close x\nEOF"))).toBe("read-only");
	});

	test("recursively classifies executable substitutions and shell -c", () => {
		expect(classify(parse('echo "$(bd create x)"'))).toBe("mutating");
		expect(classify(parse("echo `bd create x`"))).toBe("mutating");
		expect(classify(parse("gh pr create --body '`bd close x`'"))).toBe("read-only");
		expect(classify(parse("bash -c 'bd close x'"))).toBe("mutating");
		expect(classify(parse("bash -c \"$CMD\""))).toBe("unknown");
	});

	test("does not treat bd in paths, separators, or PR prose as a bd command", () => {
		expect(classify(parse("omp plugin --help; ls ~/foo/bd-thing; git branch"))).toBe("read-only");
		expect(classify(parse("gh pr create --body 'bd floor'"))).toBe("read-only");
	});

	test("allows a non-gate bd close while ignoring a quoted heredoc body", async () => {
		setBdShowRunForTests(() => ({ exitCode: 0, stdout: JSON.stringify([{ id: "bd-1", issue_type: "task" }]) }));
		try {
			const handler = registeredBashHandler();
			expect(await handler({ toolName: "bash", input: { command: "bd close bd-1 <<'EOF'\nbd close gate-2\nEOF" } }, context)).toBeUndefined();
		} finally {
			setBdShowRunForTests(null);
		}
	});

	test("fails closed on oversized input with the registration's parse reason and disable key", async () => {
		const handler = registeredBashHandler();
		const result = await handler({ toolName: "bash", input: { command: "x".repeat(64_001) } }, context) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("command could not be parsed");
		expect(result.reason).toContain("plugins.beads.gates.bash-gates.enabled=false");
		expect(blockReason({ gate: "bd-close-gate", cause: "command could not be parsed", resolution: "split the command" })).toEndWith("plugins.beads.gates.bd-close-gate.enabled=false");
	});

	test("honors a disabled close gate from the temporary project settings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-parser-disabled-"));
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "settings.json"), JSON.stringify({ plugins: { beads: { gates: { "bd-close-gate": { enabled: false } } } } }));
		let lookedUp = false;
		setBdShowRunForTests(() => {
			lookedUp = true;
			return { exitCode: 0, stdout: JSON.stringify([{ id: "bd-1", issue_type: "gate" }]) };
		});
		try {
			const handler = registeredBashHandler();
			expect(await handler({ toolName: "bash", input: { command: "bd close bd-1", cwd } }, { cwd })).toBeUndefined();
			expect(lookedUp).toBe(false);
		} finally {
			setBdShowRunForTests(null);
		}
	});

	test("marks unbalanced input unknown", () => {
		expect(parse("echo '").unknown).toBe(true);
	});

	test("honors project disable settings", () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-parser-"));
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "settings.json"), JSON.stringify({ plugins: { beads: { gates: { "bd-close-gate": { enabled: false } } } } }));
		expect(settingsEnabled("beads", "bd-close-gate", cwd)).toBe(false);
		expect(settingsEnabled("beads", "bd-actor-gate", cwd)).toBe(true);
	});
});
