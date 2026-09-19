import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockReason, classify, parse, settingsEnabled } from "./shell-command.ts";

describe("shared beads shell parser", () => {
	test("keeps quoted prose and quoted heredoc bodies out of command positions", () => {
		expect(classify(parse("echo 'bd close x'"))).toBe("read-only");
		expect(classify(parse("bd close x <<'EOF'\nbd create y\nEOF"))).toBe("mutating");
	});

	test("recursively classifies executable substitutions and shell -c", () => {
		expect(classify(parse('echo "$(bd create x)"'))).toBe("mutating");
		expect(classify(parse("gh pr create --body '`bd close x`'"))).toBe("read-only");
		expect(classify(parse("bash -c 'bd close x'"))).toBe("mutating");
		expect(classify(parse("bash -c \"$CMD\""))).toBe("unknown");
	});

	test("does not treat bd in paths or PR prose as a bd command", () => {
		expect(classify(parse("omp plugin --help; ls ~/foo/bd-thing; git branch"))).toBe("read-only");
		expect(classify(parse("gh pr create --body 'bd floor'"))).toBe("read-only");
	});

	test("fails closed on oversized or unbalanced input with the standard reason", () => {
		expect(parse("x".repeat(64_001)).unknown).toBe(true);
		expect(blockReason({ gate: "bd-close-gate", cause: "command could not be parsed", resolution: "split the command" })).toContain("could not be parsed");
		expect(blockReason({ gate: "bd-close-gate", cause: "command could not be parsed", resolution: "split the command" })).toEndWith("plugins.beads.gates.bd-close-gate.enabled=false");
	});

	test("honors project disable settings", () => {
		const cwd = mkdtempSync(join(tmpdir(), "beads-parser-"));
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "settings.json"), JSON.stringify({ plugins: { beads: { gates: { "bd-close-gate": { enabled: false } } } } }));
		expect(settingsEnabled("beads", "bd-close-gate", cwd)).toBe(false);
		expect(settingsEnabled("beads", "bd-actor-gate", cwd)).toBe(true);
	});
});
