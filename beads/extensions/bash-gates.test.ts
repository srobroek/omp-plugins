import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashGates, { beadsWorkAdmissionTarget } from "./bash-gates.ts";
import { setBdShowRunForTests } from "./bd-close-gate.ts";
import { blockReason, classify, parse, parsedInvocations, settingsEnabled } from "./shell-command.ts";

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

describe("gated tool execution target", () => {
	test("requires and resolves an explicit formula workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "beads-formula-admission-"));
		try {
			const runtimeCwd = join(root, "runtime");
			const contextCwd = join(root, "context");
			mkdirSync(join(runtimeCwd, ".beads"), { recursive: true });
			mkdirSync(contextCwd);
			const inherited = { BEADS_DIR: "/external/store" };
			const implicit = beadsWorkAdmissionTarget("bd_formula_check", {}, contextCwd, runtimeCwd, inherited);
			expect(implicit).toEqual({ cwd: runtimeCwd, env: inherited, requiresWorkspace: true });
			const empty = beadsWorkAdmissionTarget("bd_formula_check", { workspace: "" }, contextCwd, runtimeCwd, inherited);
			expect(empty.cwd).toBe(runtimeCwd);
			expect(realpathSync(empty.env.BEADS_DIR ?? "")).toBe(realpathSync(join(runtimeCwd, ".beads")));
			const explicit = beadsWorkAdmissionTarget("bd_formula_check", { workspace: "other" }, contextCwd, runtimeCwd, inherited);
			expect(explicit.cwd).toBe(join(runtimeCwd, "other"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("blocks a deep formula check without a workspace before admission", async () => {
		const result = await registeredBashHandler()({ toolName: "bd_formula_check", input: { deep: true } }, context) as { block: true; reason: string };
		expect(result.block).toBe(true);
		expect(result.reason).toContain("require an explicit workspace");
	});
	});

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
		expect(classify(parse("trap 'bd update bd-x --claim' EXIT"))).toBe("mutating");
	});

	test("recognizes quoted and escaped bd command words", () => {
		expect(classify(parse("'bd' close x"))).toBe("mutating");
		expect(classify(parse("b\\d close x"))).toBe("mutating");
		expect(classify(parse("command 'bd' close x"))).toBe("mutating");
		expect(parsedInvocations(parse("'bd' close x"))[0]?.verb).toBe("close");
		expect(parsedInvocations(parse("command 'bd' close x"))[0]?.verb).toBe("close");
	});
	test("detects bd behind leading output redirections", async () => {
		const handler = registeredBashHandler();
		setBdShowRunForTests(() => ({ exitCode: 0, stdout: JSON.stringify([{ id: "bd-1", issue_type: "gate" }]) }));
		try {
			for (const command of ["> /tmp/out bd close bd-1", ">/tmp/out bd close bd-1", "2>> /tmp/out bd close bd-1", "2>>/tmp/out bd close bd-1", "&> /tmp/out bd close bd-1", "1>&2 bd close bd-1", ">&2 bd close bd-1", "0<&1 bd close bd-1", ">| /tmp/out bd close bd-1", ">|/tmp/out bd close bd-1", "<> /tmp/out bd close bd-1", "3<>/tmp/out bd close bd-1"]) {
				expect(classify(parse(command)), command).toBe("mutating");
				const result = await handler({ toolName: "bash", input: { command } }, context) as { block?: true };
				expect(result?.block, command).toBe(true);
			}
		} finally {
			setBdShowRunForTests(null);
		}
	});


	test("blocks dynamic executables before any gate can miss them", async () => {
		for (const command of ["CMD=bd; $CMD close x", "CMD=bd; sudo -n $CMD close x", "CMD=bd; xargs -n 1 $CMD close x", "CMD=gh; sudo -n $CMD pr create --title x", "CMD=bd; if false; then :; else $CMD close x; fi", "CMD='bd close x'; if true; then eval \"$CMD\"; fi", "if true; then source ./mutate.sh; fi", "CMD=bd; coproc $CMD close x", "CMD=bd; bash -c \"$CMD\"", "CMD=bd; find . -exec $CMD close x \\;", "`printf bd` close x", "set -- bd; $@ close x", "touch bd; b? close x", "eval bd close x", "builtin eval bd close x", "trap \"$CMD\" EXIT", "shopt -s expand_aliases; alias mutate='bd update bd-x --claim'; mutate"]) {
			const result = await registeredBashHandler()({ toolName: "bash", input: { command, env: { CMD: "bd close x" } } }, context) as { block: true; reason: string };
			expect(result?.block, command).toBe(true);
			expect(result.reason).toContain("command could not be parsed");
		}
	});

	test("blocks dynamic executables after stacked command prefixes", async () => {
		const handler = registeredBashHandler();
		for (const command of ["CMD=bd; if true; then command $CMD close x; fi", "CMD=bd; if true; then env $CMD close x; fi", "CMD=bd; if true; then time $CMD close x; fi", "CMD=bd; if true; then ! $CMD close x; fi", "CMD=bd; if true; then coproc $CMD close x; fi"]) {
			const result = await handler({ toolName: "bash", input: { command } }, context) as { block?: true };
			expect(result?.block, command).toBe(true);
		}
	});

	test("does not mistake sudo host values for executables", async () => {
		const command = "CMD=bd; sudo --host localhost $CMD close x";
		const result = await registeredBashHandler()({ toolName: "bash", input: { command } }, context) as { block?: true };
		expect(result?.block).toBe(true);
	});

	test("keeps unknown wrapper option arity fail closed", async () => {
		const command = "CMD=bd; xargs -J % $CMD close x";
		const result = await registeredBashHandler()({ toolName: "bash", input: { command } }, context) as { block?: true };
		expect(result?.block).toBe(true);
	});

	test("fails closed when env changes a gated command cwd", async () => {
		const handler = registeredBashHandler();
		for (const command of ["env -C /repo-b bd update bd-1 --claim", "env -C /repo-b sh -c 'bd update bd-1 --claim'", "env --chdir=/repo-b sh -c 'gh pr create --title x'"]) {
			const blocked = await handler({ toolName: "bash", input: { command } }, context) as { block?: true; reason?: string };
			expect(blocked?.block, command).toBe(true);
			expect(blocked.reason).toContain("wrapper changes the gated command's working directory");
		}
		expect(await handler({ toolName: "bash", input: { command: "env -C /tmp echo safe" } }, context)).toBeUndefined();
	});

	test("blocks static commands supplied through opaque xargs shell execution", async () => {
		for (const command of ["printf '%s\\0' 'bd close x' | xargs -0 -n 1 sh -c", "printf '%s\\0' 'X=1 bd close x' | xargs -0 -n 1 sh -ec", "printf '%s\\0' 'gh pr create --title x' | xargs -0 -n 1 sh -c", "printf '%s\\n' 'bd update bd-x --claim' | sh", "printf '%s\\n' 'bd close x' |\nsh", "printf '%s\\n' 'bd close x' | (sh)", "printf '%s\\n' 'bd close x' | { cat >/dev/null; sh; }", "printf '%s\\n' 'bd close x' | if true; then sh; fi", "sh <<<'bd update bd-x --claim'", "sh 0<script.sh", "sh 00<script.sh", "<script.sh sh", "0<script.sh sh", "env <script.sh sh", "sh <<'EOF'\nbd close x\nEOF", "sh<<'EOF'\nbd close x\nEOF", "env sh <<'EOF'\nbd close x\nEOF", "X=1 sh <<'EOF'\nbd close x\nEOF", "<<'EOF' sh\nbd close x\nEOF", "sh <<EOF\nbd close x\nEOF"]) {
			const result = await registeredBashHandler()({ toolName: "bash", input: { command } }, context) as { block: true; reason: string };
			expect(result?.block, command).toBe(true);
			expect(result.reason).toContain("could not be parsed");
		}
	});

	test("routes static commands inside known wrapper shell options through the close gate", async () => {
		setBdShowRunForTests(() => ({ exitCode: 0, stdout: JSON.stringify([{ id: "bd-1", issue_type: "gate" }]) }));
		try {
			for (const command of ["sudo -u root sh -ec 'X=1 bd close bd-1'", "env -i sh -o errexit -c 'X=1 bd close bd-1'", "env -i bash -O extglob -c 'X=1 bd close bd-1'"]) {
				const result = await registeredBashHandler()({ toolName: "bash", input: { command } }, context) as { block?: true; reason?: string };
				expect(result?.block, command).toBe(true);
				expect(result.reason).toContain("bd-close-gate");
			}
		} finally {
			setBdShowRunForTests(null);
		}
	});
	test("fails closed on shell script operands", async () => {
		const handler = registeredBashHandler();
		for (const command of ["sh ./mutate.sh", "env sh ./mutate.sh", "bash --init-file ./mutate.sh -i -c true", "bash --rcfile ./mutate.sh -i -c true", "BASH_ENV=./mutate.sh bash -c true", "ENV=./mutate.sh sh -c true", "bash -- -c 'bd close x'", "bash script.sh -c 'bd close x'", "if true; then bash -- -c '$CMD'; fi", "if true; then bash script.sh -c '$CMD'; fi"]) {
			const result = await handler({ toolName: "bash", input: { command } }, context) as { block?: true; reason?: string };
			expect(result?.block, command).toBe(true);
			expect(result.reason).toContain("could not be parsed");
		}
		const inherited = await handler({ toolName: "bash", input: { command: "echo safe", env: { BASH_ENV: "./mutate.sh" } } }, context) as { block?: true; reason?: string };
		expect(inherited?.block).toBe(true);
		expect(inherited.reason).toContain("startup environment");
	});

	test("allows control flow that cannot reach a gated command", async () => {
		const handler = registeredBashHandler();
		for (const command of ["if test -f x; then cat x; fi", "for f in *; do echo \"$f\"; done", "while test -f x; do cat x; done"]) {
			expect(await handler({ toolName: "bash", input: { command } }, context)).toBeUndefined();
		}
		const blocked = await handler({ toolName: "bash", input: { command: "CMD=bd; if true; then $CMD close x; fi" } }, context) as { block?: true };
		expect(blocked.block).toBe(true);
	});

	test("does not treat bd in paths, separators, or PR prose as a bd command", () => {
		expect(classify(parse("omp plugin --help; ls ~/foo/bd-thing; git branch"))).toBe("read-only");
		expect(classify(parse("gh pr create --body 'bd floor'"))).toBe("read-only");
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

	test("honors a disabled admission gate for gated tools", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-admission-disabled-"));
		try {
			mkdirSync(join(cwd, ".omp"));
			writeFileSync(join(cwd, ".omp", "settings.json"), JSON.stringify({ plugins: { beads: { gates: { "beads-gate-admission": { enabled: false } } } } }));
			const handler = registeredBashHandler();
			expect(await handler({ toolName: "bd_formula_check", input: { deep: true, workspace: cwd } }, { cwd: "/different/context" })).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("marks unbalanced input unknown", () => {
		expect(parse("echo '").unknown).toBe(true);
	});

	test("allows opaque wrapper options when no gated command is reachable", async () => {
		const handler = registeredBashHandler();
		for (const command of ["env -i git status", "sudo -u root id", "xargs -n1 echo", "env -i echo *.ts", "sudo -u root cat *.txt", "xargs -n1 echo *.txt"]) {
			expect(await handler({ toolName: "bash", input: { command } }, context)).toBeUndefined();
		}
		expect(parsedInvocations(parse("env -u NAME bd close x"))[0]?.verb).toBe("close");
	});

	test("routes known wrapper options through the configured close gate", async () => {
		setBdShowRunForTests(() => ({ exitCode: 0, stdout: JSON.stringify([{ id: "bd-1", issue_type: "gate" }]) }));
		try {
			const result = await registeredBashHandler()({ toolName: "bash", input: { command: "env -u NAME bd close bd-1" } }, context) as { block?: true; reason?: string };
			expect(result?.block).toBe(true);
			expect(result.reason).toContain("bd-close-gate");
		} finally {
			setBdShowRunForTests(null);
		}
	});

	test("honors project disable settings", () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-parser-"));
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "settings.json"), JSON.stringify({ plugins: { beads: { gates: { "bd-close-gate": { enabled: false } } } } }));
		expect(settingsEnabled("beads", "bd-close-gate", cwd)).toBe(false);
		expect(settingsEnabled("beads", "bd-actor-gate", cwd)).toBe(true);
	});
});
