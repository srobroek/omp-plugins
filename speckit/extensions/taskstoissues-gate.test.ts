import { describe, expect, test } from "bun:test";

import taskstoissuesGate, {
	DENY_REASON,
	decideToolCall,
	isTaskstoissuesInvocation,
	tokenize,
} from "./taskstoissues-gate.ts";

describe("tokenize", () => {
	test("keeps a quoted title as one token and marks it quoted", () => {
		expect(tokenize("bd create --title 'port speckit-taskstoissues deny'")).toEqual([
			{ text: "bd", quoted: false },
			{ text: "create", quoted: false },
			{ text: "--title", quoted: false },
			{ text: "port speckit-taskstoissues deny", quoted: true },
		]);
	});
});

describe("isTaskstoissuesInvocation", () => {
	test("blocks command-position invocations", () => {
		for (const command of [
			"speckit-taskstoissues",
			"speckit.taskstoissues",
			"specify run /speckit.taskstoissues",
			"specify /speckit.taskstoissues",
			"sudo speckit-taskstoissues --yes",
			"FOO=1 speckit-taskstoissues",
			"echo hi; speckit-taskstoissues",
			"./bin/speckit-taskstoissues",
		]) {
			expect(isTaskstoissuesInvocation(command)).toBe(true);
		}
	});

	test("quoted mentions and other commands pass", () => {
		for (const command of [
			"bd create --title 'port speckit-taskstoissues deny'",
			"echo speckit-taskstoissues",
			"git commit -m 'speckit-taskstoissues'",
			"bd close x --reason 'retire speckit-taskstoissues'",
			"rg speckit-taskstoissues",
			"cat .specify/scripts/bash/speckit-taskstoissues.sh",
		]) {
			expect(isTaskstoissuesInvocation(command)).toBe(false);
		}
	});
});

describe("decideToolCall", () => {
	test("blocks bash invocations", () => {
		expect(decideToolCall("bash", { command: "speckit-taskstoissues" })).toEqual({
			block: true,
			reason: DENY_REASON,
		});
	});

	test("allows other tools and empty input", () => {
		expect(decideToolCall("write", { command: "speckit-taskstoissues" })).toBeUndefined();
		expect(decideToolCall("bash", {})).toBeUndefined();
	});
});

describe("register", () => {
	test("registers a tool_call handler that blocks", () => {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		taskstoissuesGate(fakePi as never);
		expect(
			handlers.tool_call?.[0]?.({
				toolName: "bash",
				toolCallId: "1",
				input: { command: "specify run /speckit.taskstoissues" },
			}),
		).toEqual({ block: true, reason: DENY_REASON });
	});

	test("fail-open on malformed input", () => {
		const handlers: Record<string, Array<(e: unknown) => unknown>> = {};
		const fakePi = {
			on: (event: string, handler: (e: unknown) => unknown) => {
				(handlers[event] ??= []).push(handler);
			},
		};
		taskstoissuesGate(fakePi as never);
		expect(handlers.tool_call?.[0]?.({ toolName: "bash", input: null })).toBeUndefined();
	});
});

describe("wrapper grammars resolve the real command slot", () => {
	const blocked = [
		"sudo -u root speckit-taskstoissues",
		"env -i speckit-taskstoissues",
		"env PATH=/x speckit-taskstoissues",
		"command -- speckit-taskstoissues",
		"command speckit-taskstoissues",
		"nohup speckit-taskstoissues &",
		"nice -n 10 speckit-taskstoissues",
		"exec -a innocent speckit-taskstoissues",
		"sudo -u root env -i speckit-taskstoissues",
		"sudo -u root specify run /speckit.taskstoissues",
		"sudo 'speckit-taskstoissues'",
		"stdbuf -o L speckit-taskstoissues",
		"sudo --user root speckit-taskstoissues",
		"sudo --group wheel speckit-taskstoissues",
		"sudo --user=root speckit-taskstoissues",
		"sudo --group=staff speckit-taskstoissues",
		"env --split-string 'speckit-taskstoissues'",
		"env -S 'env -S \"speckit-taskstoissues\"'",
		"sh -c 'speckit-taskstoissues'",
		"sudo sh -c 'speckit-taskstoissues --now'",
		"bash -c 'sudo -u root speckit-taskstoissues'",
		"sh -c 'echo hi; speckit-taskstoissues'",
		"sh -c 'echo hi && speckit-taskstoissues'",
		"sh -c 'speckit-taskstoissues | cat'",
		"bash -lc 'speckit-taskstoissues'",
		"zsh -fc 'speckit-taskstoissues'",
		"sudo bash -lc 'speckit-taskstoissues'",
		"sh -c -- 'speckit-taskstoissues'",
		"bash -c -- 'speckit-taskstoissues'",
		"bash -c speckit-taskstoissues",
		"bash -O extglob -c speckit-taskstoissues",
		"sudo bash -o posix -c 'speckit-taskstoissues'",
		"specify run '/speckit.taskstoissues'",
		"env -S 'speckit-taskstoissues'",
		"env -S 'speckit-taskstoissues --now' HOME=/tmp",
		"env --split-string='speckit-taskstoissues --now'",
		"env -S 'sudo -u root speckit-taskstoissues'",
		"env -S 'specify run /speckit.taskstoissues'",
		"sudo env -S 'specify run /speckit.taskstoissues'",
		"env -S 'env -i speckit-taskstoissues'",
	];
	for (const cmd of blocked) {
		test(`blocks: ${cmd}`, () => {
			expect(isTaskstoissuesInvocation(cmd)).toBe(true);
		});
	}
	const allowed = [
		"sudo echo speckit-taskstoissues",
		"env printf speckit-taskstoissues",
		"sudo -u root grep speckit-taskstoissues notes.md",
		"sudo -u root grep 'speckit-taskstoissues' notes.md",
		"sudo cat speckit-taskstoissues.log",
		"env -i bd create --title 'port speckit-taskstoissues deny'",
		"sudo -u root echo done; bd create --title 'speckit-taskstoissues'",
		"nice -n 10 rg speckit-taskstoissues",
		"sudo --user root echo speckit-taskstoissues",
		"sudo sh -c 'echo speckit-taskstoissues'",
		"sh -c 'grep speckit-taskstoissues notes.md'",
		"sh -c 'echo speckit-taskstoissues; echo done'",
		"bash -lc 'echo speckit-taskstoissues'",
		"bash -- -c speckit-taskstoissues",
		"bash -o posix -c 'echo speckit-taskstoissues'",
		"bash --norc speckit-taskstoissues",
		"bash +c speckit-taskstoissues",
		"zsh +o posix -c 'echo speckit-taskstoissues'",
		"bash --rcfile x speckit-taskstoissues",
		"env -S 'echo speckit-taskstoissues'",
		"env -S 'sudo echo speckit-taskstoissues'",
		"env -S 'echo ; speckit-taskstoissues'",
		"env -S 'echo speckit-taskstoissues | cat'",
	];
	for (const cmd of allowed) {
		test(`passes: ${cmd}`, () => {
			expect(isTaskstoissuesInvocation(cmd)).toBe(false);
		});
	}
});
