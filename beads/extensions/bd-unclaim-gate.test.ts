import { describe, expect, test } from "bun:test";

import bashGates from "./bash-gates.ts";
import { decideBdUnclaim, decideBdUnclaimParsed } from "./bd-unclaim-gate.ts";
import { blockReason, parse } from "./shell-command.ts";

type Handler = (event: unknown, context?: unknown) => Promise<unknown>;

function registeredBashHandler(): Handler {
	const handlers: Handler[] = [];
	bashGates({
		on(event: string, handler: Handler) {
			if (event === "tool_call") handlers.push(handler);
		},
		sendMessage() {},
	} as never);
	const handler = handlers[0];
	if (handler === undefined) throw new Error("bash gate did not register a tool_call handler");
	return handler;
}

const context = { cwd: "/tmp" };
const cause = "bd unclaim requires a non-empty --if-assignee compare-and-swap guard";
const resolution = "retry with `bd unclaim <id> --if-assignee <your actor>`";

function decision(command: string) {
	return decideBdUnclaimParsed(parse(command));
}

describe("bd unclaim gate", () => {
	test("refuses unguarded unclaim and force", () => {
		for (const command of ["bd unclaim bead-1", "bd unclaim bead-1 --force", "a && bd unclaim bead-1"]) {
			expect(decideBdUnclaim(command)?.block).toBe(true);
		}
	});

	test("requires a non-empty if-assignee value", () => {
		for (const command of ["bd unclaim bead-1 --if-assignee", "bd unclaim bead-1 --if-assignee=", "bd unclaim bead-1 --if-assignee \"\""]) {
			expect(decideBdUnclaim(command)?.block).toBe(true);
		}
	});

	test("allows both guarded spellings", () => {
		expect(decideBdUnclaim("bd unclaim bead-1 --if-assignee omp/main")).toBeUndefined();
		expect(decideBdUnclaim("bd unclaim bead-1 --if-assignee=omp/main")).toBeUndefined();
		expect(decideBdUnclaim("bd unclaim bead-1 --if-assignee omp/main --force")).toBeUndefined();
	});

	test("allows help without a guard", () => {
		expect(decision("bd unclaim --help")).toBeUndefined();
		expect(decision("bd unclaim -h")).toBeUndefined();
	});
	test("matches only the wrapper executable and recurses through nested wrappers", () => {
		expect(decideBdUnclaim("env printf bd unclaim bead-1")).toBeUndefined();
		for (const command of [
			"env -u A command -- bd unclaim bead-1",
			"command env bd unclaim bead-1",
			"env /opt/bin/bd unclaim bead-1",
			"command -- ./bd unclaim bead-1",
		]) expect(decideBdUnclaim(command)?.block).toBe(true);
	});

	test("does not treat a positional help argument after -- as help", () => {
		expect(decideBdUnclaim("bd unclaim bead-1 -- --help")?.block).toBe(true);
	});

	test("allows explicit help flags before the option terminator", () => {
		expect(decideBdUnclaim("bd unclaim --help bead-1")?.block).toBeUndefined();
		expect(decideBdUnclaim("bd unclaim --help -- bead-1")?.block).toBeUndefined();
	});
	test("ignores prose that is not a bd invocation", () => {
		for (const command of ["echo 'bd unclaim bead-1'", "printf '%s\\n' bd unclaim bead-1"]) {
			expect(decideBdUnclaim(command)).toBeUndefined();
		}
	});

	test("Bash refusal uses the standard block reason and retry", async () => {
		const result = await registeredBashHandler()({ toolName: "bash", input: { command: "bd unclaim bead-1" } }, context);
		expect(result).toEqual({ block: true, reason: blockReason({ gate: "bd-unclaim-gate", cause, resolution }) });
	});
});
