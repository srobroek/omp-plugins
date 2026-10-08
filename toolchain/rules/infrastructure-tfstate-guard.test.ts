import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "infrastructure-tfstate-guard.md");

function frontmatter(): string[] {
	const text = fs.readFileSync(RULE, "utf8");
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!block) throw new Error("no frontmatter");
	return (block[1] as string).split(/\r?\n/);
}

function field(name: string): string {
	const line = frontmatter().find(l => l.startsWith(`${name}:`));
	if (!line) throw new Error(`no ${name}`);
	return line.slice(name.length + 1).trim();
}

function conditions(): RegExp[] {
	const parsed = JSON.parse(field("condition")) as string | string[];
	const patterns = Array.isArray(parsed) ? parsed : [parsed];
	return patterns.map(pattern => {
		const flags = /^\(\?([ims]+)\)/.exec(pattern);
		return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
	});
}

/**
 * The bash tool exposes no matcher digest, so a live TTSR buffer holds the call's
 * argument JSON (`{"command":"…","i":"…"}`), while `omp ttsr test` and a first
 * partial delta hold the bare command. Every case is checked in both encodings.
 */
const encodings = (command: string): string[] => [command, JSON.stringify({ command, i: "Running" })];

const FIRE = [
	"terraform state rm aws_instance.old",
	"TOFU STATE MV old new",
	"rm terraform.tfstate*",
	"rm -f terraform.tfstate",
	"git rm terraform.tfstate",
	"git rm --cached terraform.tfstate.backup",
	"echo ready; git rm terraform.tfstate",
	"terraform -chdir=infra state rm aws_instance.old",
	"tofu -chdir=envs/prod state mv a b",
	"cd infra && terraform state push errored.tfstate",
	"if true; then terraform state rm x; fi",
	"rm envs/prod/terraform.tfstate",
	"rm -f prod.tfstate",
	"mv backup.tfstate terraform.tfstate",
	"cp -f old/terraform.tfstate envs/prod/terraform.tfstate",
	"cat restored.json > terraform.tfstate",
	"echo '{}' >> envs/prod/terraform.tfstate",
	"terraform state pull > terraform.tfstate",
	"cp backup.tfstate \"terraform.tfstate\"",
	"jq '.version = 4' state.json > terraform.tfstate",
	"cat \"my backup\" > terraform.tfstate",
	"cd infra && terraform state pull > terraform.tfstate",
];

const HOLD = [
	"terraform plan",
	"terraform state list",
	"terraform state show aws_instance.old",
	"terraform -chdir=infra state list",
	"echo \"terraform state rm aws_instance.old\"",
	"echo \"rm terraform.tfstate*\"",
	"bd create --description \"git rm terraform.tfstate\"",
	"git rm main.tf",
	"cp terraform.tfstate terraform.tfstate.backup",
	"terraform state pull > backup.tfstate",
	"cat terraform.tfstate",
	"ls *.tfstate",
	"rm -rf build && cat terraform.tfstate",
	"cp terraform.tfstate backup.tfstate",
	"cp terraform.tfstate /tmp/state-backup.tfstate",
	"echo \"restore with: cat backup > terraform.tfstate\"",
	"echo 'cat backup > terraform.tfstate'",
];

describe("infrastructure-tfstate-guard", () => {
	const res = conditions();
	for (const text of FIRE) {
		test(`fires: ${JSON.stringify(text)}`, () => {
			for (const buffer of encodings(text)) expect({ buffer, fired: res.some(re => re.test(buffer)) }).toEqual({ buffer, fired: true });
		});
	}
	for (const text of HOLD) {
		test(`does not fire: ${JSON.stringify(text)}`, () => {
			for (const buffer of encodings(text)) expect({ buffer, fired: res.some(re => re.test(buffer)) }).toEqual({ buffer, fired: false });
		});
	}

	test("interrupts before the command runs", () => {
		expect(field("interruptMode")).toBe("always");
	});

	test("watches bash only: its conditions read shell text, which an edit or write digest never holds", () => {
		expect(JSON.parse(field("scope"))).toBe("tool:bash");
	});
});
