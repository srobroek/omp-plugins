/**
 * Corpus for the find-tools-no-install advisory.
 *
 * A `tool:bash` rule sees the bash call's streamed argument JSON
 * (`{"command":"…","i":"…"}`: inner `"` arrive as `\"`, newlines as `\n`) and,
 * for a first partial delta or `omp ttsr test`, the bare command. Every case is
 * checked in both encodings, with an intent argument in the JSON one.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "find-tools-no-install.md");

function rule(): { description: string; condition: RegExp } {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const lines = (frontmatter[1] as string).split(/\r?\n/);
	const field = (name: string) => lines.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
	const condition = field("condition");
	if (!condition) throw new Error("no condition");
	const pattern = (JSON.parse(condition) as string[])[0];
	if (!pattern) throw new Error("empty condition");
	return { description: field("description") ?? "", condition: new RegExp(pattern) };
}

const FIRE = [
	"npx skills add foo",
	"npx --yes skills add foo",
	"npx -y skills add foo",
	"npx --yes skills@1.7.0 add OWNER/REPO --skill NAME -a universal -y",
	"bunx skills add foo",
	"bunx skills@1.7.0 add foo",
	"pnpm dlx skills add foo",
	"npm exec -- skills add foo",
	"npm exec --yes -- skills@1.7.0 add foo",
	"npm exec skills@1.7.0 -- add foo",
	"npx -y @smithery/cli install @acme/browser --client claude",
	"npx -y @smithery/cli@latest mcp add acme",
	"smithery mcp add foo",
	"cd repo && npx -y skills add foo",
	"if true; then bunx skills add foo; fi",
	"cd repo\npnpm dlx skills add foo",
	"echo \"setting up\" && npx skills add foo",
	"sudo npx skills add foo",
	"yarn dlx skills add foo",
];

const HOLD = [
	"echo npx skills add foo",
	"echo sudo npx skills add foo",
	"echo \"npx skills add\"",
	"echo 'cd x; npx skills add foo'",
	"git commit -m \"docs: cd x && npx skills add foo\"",
	"npm i -D bunx-test",
	"npx skills find browser",
	"npx --yes smithery@1.2.0 mcp search browser",
	"bd create --description 'run npx skills add later'",
];

describe("find-tools-no-install", () => {
	const { description, condition } = rule();

	test("description names an advisory, not a block", () => {
		expect(description).not.toMatch(/\bblock/i);
		expect(description).toMatch(/\b(?:remind|warn|advis)/i);
	});

	for (const command of FIRE) {
		test(`fires: ${command}`, () => {
			expect(condition.test(command)).toBe(true);
			expect(condition.test(JSON.stringify({ command, i: "Installing a skill" }))).toBe(true);
			expect(condition.test(JSON.stringify({ i: "Installing a skill", command }))).toBe(true);
		});
	}
	for (const command of HOLD) {
		test(`holds: ${command}`, () => {
			expect(condition.test(command)).toBe(false);
			expect(condition.test(JSON.stringify({ command, i: "Checking state" }))).toBe(false);
			expect(condition.test(JSON.stringify({ i: "Checking state", command }))).toBe(false);
		});
	}
	test("holds: an install command named only in the intent", () => {
		expect(condition.test(JSON.stringify({ command: "ls", i: "Before cd x; npx skills add foo" }))).toBe(false);
		expect(condition.test(JSON.stringify({ i: "Before cd x; npx skills add foo", command: "ls" }))).toBe(false);
	});
});
