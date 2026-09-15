import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GitRun, steeringDirective, targetRepoAuthorizes } from "./target-repo-steering.ts";

let scratch: string | undefined;

function setupRepo(): string {
	scratch = mkdtempSync(join(tmpdir(), "target-steering-"));
	return scratch;
}

function fakeGit(root: string): GitRun {
	return () => ({ exitCode: 0, stdout: `${root}\n` });
}

afterEach(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

describe("targetRepoAuthorizes", () => {
	test.each([
		["leading space", " MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["four-space code block", "    MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository."],
		["trailing space", "MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository. "],
		[
			"fenced/example text",
			"```\nexample: MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.\n```",
		],
	])("does not authorize %s", (_description, content) => {
		const root = setupRepo();
		writeFileSync(join(root, "AGENTS.md"), content);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root))).toBe(false);
	});

	test("authorizes an exact standalone directive with CRLF line endings", () => {
		const root = setupRepo();
		writeFileSync(
			join(root, "AGENTS.md"),
			`# Delivery\r\n${steeringDirective("DELIVERY_ALLOW_MAIN_COMMIT")}\r\n# End\r\n`,
		);
		expect(targetRepoAuthorizes(root, "DELIVERY_ALLOW_MAIN_COMMIT", fakeGit(root))).toBe(true);
	});
});
