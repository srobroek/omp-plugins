/**
 * Corpus for aws-skill-first. The rule is `scope: "tool:bash"`, so it sees a
 * bash call's streamed argument JSON (`{"command":"…","i":"…"}`) and, on a
 * first partial delta or under `omp ttsr test --source tool --tool bash`, the
 * bare command. Every case is checked in both encodings.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "aws-skill-first.md");

function conditions(): RegExp[] {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error(`${RULE}: no frontmatter`);
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error(`${RULE}: no condition`);
	const parsed: unknown = JSON.parse(line.slice("condition:".length).trim());
	if (!Array.isArray(parsed) || parsed.some(p => typeof p !== "string")) {
		throw new Error(`${RULE}: condition is not a list of patterns`);
	}
	return (parsed as string[]).map(p => new RegExp(p));
}

const CONDITIONS = conditions();

/** Both encodings a live buffer can hold for one bash call: argument JSON and the bare command. */
function firesInBoth(command: string, intent: string): boolean[] {
	return [JSON.stringify({ command, i: intent }), command].map(buffer => CONDITIONS.some(re => re.test(buffer)));
}

const FIRE: string[] = [
	"aws s3 sync ./site s3://bucket",
	"aws sts get-caller-identity",
	"AWS_PROFILE=dev aws cloudformation deploy --stack-name x",
	"cd infra && npx cdk deploy --all",
	"cdk synth",
	"sam deploy --guided",
	"(aws ec2 describe-instances)",
];

const NOT_FIRE: string[] = [
	"aws --version",
	"grep -rn aws src/",
	"terraform apply",
	"uvx mcp-proxy-for-aws-cli@latest https://aws-mcp.us-east-1.api.aws/mcp",
	"cdk --help",
	"sam local invoke",
	"cat awsconfig/aws s3 notes.txt",
];

describe("aws-skill-first must fire", () => {
	for (const command of FIRE) {
		test(`fires on ${command}`, () => {
			expect(firesInBoth(command, "Running an AWS command")).toEqual([true, true]);
		});
	}
});

describe("aws-skill-first must not fire", () => {
	for (const command of NOT_FIRE) {
		test(`does not fire on ${command}`, () => {
			expect(firesInBoth(command, "Checking the toolchain")).toEqual([false, false]);
		});
	}
});
