import { describe, expect, test } from "bun:test";

import { shouldInvestigate } from "./package-investigate.ts";

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
		"npm search typescript",
        "npm --silent install left-pad",
        "npm --prefix /tmp install left-pad",
        "pnpm --global add typescript",
        "cargo --quiet add serde",
		"pip index versions requests",
		"cargo search serde",
		"(bun add left-pad)",
		"$(npm i -D typescript)",
		"cd x; (pip install requests)",
	]) {
		test(`fires: ${command}`, () => expect(shouldInvestigate(command)).toBe(true));
	}

	for (const command of [
		"bd create \"note ; npm install foo happened\"",
		"git commit -m \"fix; bun add left-pad was wrong\"",
		"echo \"step 2 & pip install requests\"",
		"bun install",
		"bun install --silent",
		"pnpm install --frozen-lockfile",
		"npm install",
        "npm --silent install",
		"cat <<'EOF'\nbun add foo\nEOF",
		"toString bun add left-pad",
		"constructor npm i -D typescript",
	]) {
		test(`silent: ${command}`, () => expect(shouldInvestigate(command)).toBe(false));
	}
});
