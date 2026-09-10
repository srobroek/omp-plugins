import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { boundaryDecision } from "./scaffold-boundary.ts";

function rootWithRun(owned: string[] = []): string {
	const root = mkdtempSync(join(tmpdir(), "scaffold-boundary-"));
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "scaffold-run.json"), JSON.stringify({ root, started: "now" }));
	writeFileSync(join(root, ".omp", "scaffold.json"), JSON.stringify({ owned_hashes: Object.fromEntries(owned.map((path) => [path, "hash"])) }));
	return root;
}

function event(toolName: string, input: Record<string, unknown>): ExtensionToolCallEvent {
	return { toolName, toolCallId: "test", input } as unknown as ExtensionToolCallEvent;
}

describe("scaffold boundary activation", () => {
	test("passes every tool through when the run marker is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "scaffold-boundary-inactive-"));
		expect(boundaryDecision(event("eval", { cwd: root, code: "1 + 1" }))).toBeUndefined();
		expect(boundaryDecision(event("bash", { cwd: root, command: "chezmoi apply" }))).toBeUndefined();
	});

	test("blocks eval and write/edit paths outside or owned by the scaffold", () => {
		const root = rootWithRun(["generated.txt"]);
		expect(boundaryDecision(event("eval", { cwd: root, code: "write()" }))?.block).toBe(true);
		expect(boundaryDecision(event("write", { cwd: root, path: "/tmp/outside.txt" }))?.reason).toContain("scaffold apply");
		expect(boundaryDecision(event("edit", { cwd: root, path: "generated.txt" }))?.reason).toContain("generated.txt");
		expect(boundaryDecision(event("ast_edit", { cwd: root, paths: ["generated.txt"] }))?.block).toBe(true);
	});
});

describe("scaffold bash denylist", () => {
	const blocked = [
		"chezmoi apply --force",
		"chezmoi init",
		"chezmoi update",
		"omp config set foo bar",
		"omp config unset foo",
		"omp plugin install foo@bar",
		"omp plugin uninstall foo",
		"omp plugin marketplace add foo",
		"omp plugin marketplace remove foo",
		"git push origin main",
		"git commit --amend --no-edit",
		"mise use -g python@3.13",
		"brew install jq",
		"apt install jq",
		"pip install jq",
		"npm -g install jq",
		"cargo install ripgrep",
		"go install example.com/tool@latest",
		"sudo rm -rf /tmp/x",
		"echo x > /tmp/outside.txt",
		"tee /tmp/outside.txt",
		"cp source /tmp/outside.txt",
		"mv source ~/outside.txt",
	];

	test.each(blocked)("blocks %s", (command) => {
		const root = rootWithRun();
		const result = boundaryDecision(event("bash", { cwd: root, command }));
		expect(result?.block, command).toBe(true);
		expect(result?.reason, command).toContain("scaffold apply");
	});

	test("allows the documented safe commands", () => {
		const root = rootWithRun();
		for (const command of [
			"git status",
			"bd list",
			`python3 ${root}/x/scaffold.py apply`,
			"just check",
			"omp plugin install foo@bar --scope project",
			`echo x > ${root}/inside.txt`,
			`cp source ${root}/inside.txt`,
		]) {
			expect(boundaryDecision(event("bash", { cwd: root, command })), command).toBeUndefined();
		}
	});
});
