import { expect, test } from "bun:test";
import type { Command } from "./spec-start.ts";
import { startSpec } from "./spec-start.ts";

const spec = "001-example";
const options = { spec, workspace: "/unused" };

test("missing choice asks before creating any workflow", async () => {
	const command: Command = async args => { if (args[0] === "query") return []; throw new Error("unexpected mutation"); };
	expect(await startSpec(options, command)).toMatchObject({ status: "CHOICE_REQUIRED" });
});

test("resume reuses recorded choice without mutation", async () => {
	const root = { id: "run", metadata: { spec_dir: `specs/${spec}`, human_approvals: "no", autonomous: "yes" } };
	const command: Command = async args => { if (args[0] === "query" || args[0] === "show") return [root]; throw new Error("unexpected mutation"); };
	expect(await startSpec(options, command)).toMatchObject({ status: "READY", root: "run", humanApprovals: "no", autonomous: "yes" });
});

test("contradictory recorded choices cannot advance", async () => {
	const command: Command = async () => [{ id: "run", metadata: { spec_dir: `specs/${spec}`, human_approvals: "no", autonomous: "no" } }];
	expect(startSpec(options, command)).rejects.toThrow("Contradictory");
});

test("fresh decline requires separate consent for an existing gated run", async () => {
	const command: Command = async args => { if (args[0] === "query") return [{ id: "run", metadata: { spec_dir: `specs/${spec}` } }]; throw new Error("unexpected mutation"); };
	expect(await startSpec({ ...options, approvals: "no", decision: "No routine sign-offs" }, command)).toMatchObject({ status: "MIGRATION_REQUIRED", root: "run" });
});

test("migration refuses a gate without scoped ownership before any write", async () => {
	const root = { id: "run", metadata: { spec_dir: `specs/${spec}`, human_approvals: "yes", autonomous: "no" } };
	const command: Command = async args => {
		if (args[0] === "query") return [root];
		if (args[0] === "mol") return { issues: [root, { id: "step", title: `clarify approval ${spec}` }, { id: "gate", await_type: "human", description: "Async gate for step clarify-approval", status: "open" }], dependencies: [{ issue_id: "step", depends_on_id: "gate", type: "blocks" }] };
		throw new Error("unexpected mutation");
	};
	expect(startSpec({ ...options, approvals: "no", migrate: true, decision: "Explicitly migrate routine approvals" }, command)).rejects.toThrow("ownership");
});

test("invalid spec input is rejected before ledger access", async () => {
	const command: Command = async () => { throw new Error("ledger was accessed"); };
	expect(startSpec({ ...options, spec: "001-example\" or true" }, command)).rejects.toThrow("NNN-slug");
});
