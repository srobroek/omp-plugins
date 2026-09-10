import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TOOLS, type ToolRec } from "./sniff-tool-catalog";

const RULE_PATH = new URL(
	"../rules/quality-sniff-analyzer-redirect.md",
	import.meta.url,
);
const records = Object.values(TOOLS).flat() as ToolRec[];

function ruleRegex(): RegExp {
	const frontmatter = readFileSync(RULE_PATH, "utf8")
		.split("\n")
		.find((line) => line.startsWith("condition: "));
	if (!frontmatter) throw new Error("missing TTSR condition");
	const [source] = JSON.parse(frontmatter.slice("condition: ".length)) as [
		string,
	];
	const multiline = source.startsWith("(?m)");
	return new RegExp(multiline ? source.slice(4) : source, multiline ? "m" : "");
}

describe("quality-sniff-analyzer-redirect", () => {
	test("matches every catalogued analyzer only with the active marker", () => {
		const regex = ruleRegex();
		const missed = records
			.map(
				(rec) =>
					`OMP_SNIFF_ACTIVE=1 ${[rec.bin, ...(rec.runPrefix ?? [])].join(" ")} --version`,
			)
			.filter((command) => !regex.test(command));
		const unmarkedMatches = records
			.map(
				(rec) => `${[rec.bin, ...(rec.runPrefix ?? [])].join(" ")} --version`,
			)
			.filter((command) => regex.test(command));
		expect(missed).toEqual([]);
		expect(unmarkedMatches).toEqual([]);
	});

	test("matches supported package runners", () => {
		const regex = ruleRegex();
		const missed = records
			.filter((rec) => rec.key === "npm" || rec.key === "npm-local")
			.map((rec) => `OMP_SNIFF_ACTIVE=1 npx --no-install ${rec.bin} --version`)
			.filter((command) => !regex.test(command));
		expect(missed).toEqual([]);
		expect(regex.test("OMP_SNIFF_ACTIVE=1 npx eslint@latest .")).toBe(true);
	});

	test("ignores mentions and unrelated commands", () => {
		const regex = ruleRegex();
		const controls = [
			"OMP_SNIFF_ACTIVE=0 eslint .",
			"OMP_SNIFF_ACTIVE=1 echo eslint .",
			"OMP_SNIFF_ACTIVE=1 printf 'eslint .'",
			"OMP_SNIFF_ACTIVE=1 git grep eslint",
			"OMP_SNIFF_ACTIVE=1 cargo test",
			"OMP_SNIFF_ACTIVE=1 go test ./...",
			"OMP_SNIFF_ACTIVE=1 glab issue list",
			"OMP_SNIFF_ACTIVE=1 npx go test ./...",
			"echo OMP_SNIFF_ACTIVE=1 eslint .",
			"git commit -m 'OMP_SNIFF_ACTIVE=1 eslint .'",
			"OMP_SNIFF_ACTIVE=1 true # eslint .",
			"sniff_run_analyzer tool=eslint",
			"OMP_SNIFF_ACTIVE=1 eslint-wrapper .",
			"OMP_SNIFF_ACTIVE=1 npx eslint.js .",
			"OMP_SNIFF_ACTIVE=1 ./node_modules/.bin/eslint-wrapper .",
		];
		expect(controls.filter((command) => regex.test(command))).toEqual([]);
	});
});
