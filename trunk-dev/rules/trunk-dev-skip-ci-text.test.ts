import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "trunk-dev-skip-ci-text.md");

function conditions(): RegExp[] {
	const text = fs.readFileSync(RULE, "utf8");
	const line = text.split(/\r?\n/).find(candidate => candidate.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const parsed = JSON.parse(line.slice("condition:".length).trim()) as string[];
	return parsed.map(pattern => {
		const flags = /^\(\?([ims]+)\)/.exec(pattern);
		return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
	});
}
/** A `tool:bash` rule sees streamed JSON tool arguments, not the bare command. */
function buffers(command: string): string[] {
	return [JSON.stringify({ command }), JSON.stringify({ i: "Running command", command, timeout: 60 })];
}

const MATCHES = [
	'git commit -m "feat: add release [skip ci]"',
	'git commit --message="fix: quote [CI SKIP] in prose"',
	'glab mr create --title "feat: ship it" --description "The docs mention [no ci] as a warning"',
	'glab mr update 12 --description "Example token: [skip actions]"',
	'gh pr create --title "fix: repair build" --body "Example token: [skip actions]"',
	'gh pr merge 12 --body "quoted marker [No CI]"',
	'echo ready && git commit -m "chore: explain [skip ci]"',
];

const NON_MATCHES = [
	"git status --short",
	'git commit -m "feat: ship normally"',
	'glab issue create --title "[skip ci]"',
	'gh issue create --title "[skip ci]"',
	'echo "[skip ci]"',
	'git commit --file message.txt',
];

describe("trunk-dev-skip-ci-text", () => {
	const res = conditions();
	for (const command of MATCHES) {
		test(`matches: ${JSON.stringify(command)}`, () => {
			for (const buffer of buffers(command)) expect(res.some(re => re.test(buffer))).toBe(true);
		});
	}
	for (const command of NON_MATCHES) {
		test(`does not match: ${JSON.stringify(command)}`, () => {
			for (const buffer of buffers(command)) expect(res.some(re => re.test(buffer))).toBe(false);
		});
	}
});
