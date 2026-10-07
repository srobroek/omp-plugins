import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRuleCondition } from "@oh-my-pi/pi-coding-agent/capability/rule";

const RULE = path.join(import.meta.dir, "dep-update-no-scanner-install.md");

function conditions(): RegExp[] {
	const text = fs.readFileSync(RULE, "utf8");
	const line = text.split(/\r?\n/).find((l) => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	return (JSON.parse(line.slice("condition:".length).trim()) as string[]).map(compileRuleCondition);
}

/** A `tool:bash` rule sees the streamed JSON arguments, never the bare command. */
function buffers(command: string): string[] {
	return [JSON.stringify({ command }), JSON.stringify({ i: "Running audit", command, timeout: 60 })];
}

const FIRE = [
	"pip install pip-audit",
	"pip3 install --user pip-audit",
	"python -m pip install pip-audit",
	'python3 -m pip install "pip-audit==2.7.0"',
	"pipx install pip-audit",
	"uv tool install pip-audit",
	"brew install osv-scanner",
	"npm install --global osv-scanner",
	"npm i -g osv-scanner",
	"cargo install cargo-audit",
	"cargo install --locked cargo-audit",
	"cargo binstall cargo-audit",
	"go install golang.org/x/vuln/cmd/govulncheck@latest",
	"go install golang.org/x/vuln/cmd/govulncheck@v1.1.3",
	"cd /tmp && pip install pip-audit",
	"echo hi; sudo pip install pip-audit",
	"if true; then pipx install pip-audit; fi",
	"ls\npip install pip-audit",
];

const HOLD = [
	"uvx pip-audit",
	"go run golang.org/x/vuln/cmd/govulncheck@latest",
	'echo "pip install pip-audit"',
	'echo "x && pip install pip-audit"',
	"printf 'cargo install cargo-audit'",
	"echo 'a; pipx install pip-audit'",
	"pip install requests --log pip-audit.log",
	'bd create --description "cargo install cargo-audit"',
	"npm install --save-dev osv-scanner-helper",
	"pip-audit -r requirements.txt",
	"command -v pip-audit",
	'git commit -m "brew install osv-scanner"',
	"echo pip install pip-audit",
];

describe("dep-update-no-scanner-install", () => {
	const res = conditions();
	for (const command of FIRE) {
		test(`fires: ${JSON.stringify(command)}`, () => {
			for (const buffer of buffers(command)) expect(res.some((re) => re.test(buffer))).toBe(true);
		});
	}
	for (const command of HOLD) {
		test(`holds: ${JSON.stringify(command)}`, () => {
			for (const buffer of buffers(command)) expect(res.some((re) => re.test(buffer))).toBe(false);
		});
	}
	test("is advisory: never interrupts, and says so", () => {
		const text = fs.readFileSync(RULE, "utf8");
		expect(text).toContain("interruptMode: never");
		expect(text).not.toMatch(/^description:.*\bblock\b/m);
		expect(text).not.toMatch(/(?:npx|bunx|pnpm dlx) osv-scanner/);
	});
});
