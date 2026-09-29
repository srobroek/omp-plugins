import { describe, expect, test } from "bun:test";

import { createPackageGate, packagesToInvestigate, shouldInvestigate } from "./package-investigate.ts";

describe("package investigation", () => {
	for (const command of [
		"npm i -D typescript",
		"bun add left-pad",
		"cd x && bun add left-pad",
		"npm install typescript --save-dev",
		"uv add httpx",
		"cargo add serde",
		"go get example.com/x",
		"pip install requests",
		"(bun add left-pad)",
		"$(npm i -D typescript)",
		"cd x; (pip install requests)",
		"FOO=1 bun add x",
		"\"bun\" add x",
		"bun add \"x\"",
		"bun add -d sharp@0.35.5 2>&1 | tail -2",
	]) {
		test(`fires: ${command}`, () => expect(shouldInvestigate(command)).toBe(true));
	}

	for (const command of [
		"bd create \"note ; npm install foo happened\"",
		"git commit -m \"fix; bun add left-pad was wrong\"",
		"echo \"step 2 & pip install requests\"",
		"echo bun add x",
		"bun install",
		"bun install --silent",
		"pnpm install --frozen-lockfile",
		"npm install",
		"bun install | tail",
		"bun install 2>&1 | tail -2 && git diff --stat",
		"bun install > install.log",
		"bun install >install.log 2>/dev/null; git status",
		"npm view sharp@0.35.5 --json",
		"npm search typescript",
		"bun view sharp",
		"pip index versions requests",
		"cargo search serde",
		"cat <<'EOF'\nbun add foo\nEOF",
		"toString bun add left-pad",
		"constructor npm i -D typescript",
	]) {
		test(`silent: ${command}`, () => expect(shouldInvestigate(command)).toBe(false));
	}

	test("package operands stop at the first separator", () => {
		expect(packagesToInvestigate("bun add a | tail -2 && git diff")).toEqual(["a"]);
		expect(packagesToInvestigate("bun add a && bun add b")).toEqual(["a", "b"]);
		expect(packagesToInvestigate("bun add a > out.txt")).toEqual(["a"]);
	});
});

describe("package gate retry", () => {
	test("blocks the first attempt, then allows an identical retry", () => {
		const gate = createPackageGate();
		expect(gate.check("bun add -d sharp@0.35.5")).toContain("investigate the package");
		expect(gate.check("bun add -d sharp@0.35.5")).toBeUndefined();
	});

	test("a command adding a new package blocks again, naming only the new one", () => {
		const gate = createPackageGate();
		expect(gate.check("bun add a")).toBeDefined();
		const reason = gate.check("bun add a && bun add b");
		expect(reason).toContain("Packages: b.");
		expect(gate.check("bun add a && bun add b")).toBeUndefined();
	});

	test("read-only lookups never block and never acknowledge", () => {
		const gate = createPackageGate();
		expect(gate.check("npm view sharp --json")).toBeUndefined();
		expect(gate.check("bun add sharp")).toBeDefined();
	});

	test("reset forgets acknowledged packages", () => {
		const gate = createPackageGate();
		gate.check("bun add sharp");
		gate.reset();
		expect(gate.check("bun add sharp")).toBeDefined();
	});
});
