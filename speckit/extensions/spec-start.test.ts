import { describe, expect, test } from "bun:test";
import type { Command } from "./spec-start.ts";
import { startSpec } from "./spec-start.ts";

const spec = "001-example";
const options = { spec, workspace: "/unused" };
type Row = { id: string; title?: string; description?: string; status?: string; issue_type?: string; spec_id?: string; await_type?: string; metadata?: Record<string, string> };
type Edge = { issue_id: string; depends_on_id: string; type: string };
const runRoot = (metadata?: Record<string, string>): Row => ({ id: "run", title: "speckit-feature", issue_type: "molecule", spec_id: spec, status: "open", metadata });

/** A gated run as `bd mol pour speckit-feature --var autonomous=no` lays it out. */
function gatedRun(metadata?: Record<string, string>): { root: Row; issues: Row[]; dependencies: Edge[] } {
	const root = runRoot(metadata);
	const issues: Row[] = [root];
	const dependencies: Edge[] = [];
	for (const [name, title, before, after] of [
		["clarify-approval", "clarify approval", "clarify", "plan"],
		["analyze-approval", "analyze approval", "analyze", "implement"],
		["verify-signoff", "verify sign-off", "verify", "review"],
	] as const) {
		const step: Row = { id: `step-${name}`, title: `${title} ${spec}`, issue_type: "task", status: "open" };
		const gate: Row = { id: `gate-${name}`, title: "Gate: human", issue_type: "gate", await_type: "human", description: `Async gate for step ${name}`, status: "open" };
		issues.push(step, gate, { id: before, title: `${before} ${spec}`, issue_type: "task", status: "open" }, { id: after, title: `${after} ${spec}`, issue_type: "task", status: "open" });
		for (const id of [step.id, gate.id, before, after]) dependencies.push({ issue_id: id, depends_on_id: root.id, type: "parent-child" });
		dependencies.push(
			{ issue_id: step.id, depends_on_id: gate.id, type: "blocks" },
			{ issue_id: step.id, depends_on_id: before, type: "blocks" },
			{ issue_id: after, depends_on_id: step.id, type: "blocks" },
			{ issue_id: after, depends_on_id: before, type: "blocks" },
		);
	}
	return { root, issues, dependencies };
}

/** An in-memory ledger serving one run; mutations it does not model fail the test. */
function ledger(run: { root: Row; issues: Row[]; dependencies: Edge[] }, extraQueryRows: Row[] = []) {
	const log: string[][] = [];
	const find = (id: string | undefined) => {
		const row = run.issues.find(issue => issue.id === id);
		if (!row) throw new Error(`unknown issue ${id}`);
		return row;
	};
	const command: Command = async args => {
		log.push(args);
		if (args[0] === "query") return [...extraQueryRows, run.root];
		if (args[0] === "show") return [run.root];
		if (args[0] === "mol" && args[1] === "show") return { issues: run.issues, dependencies: run.dependencies };
		if (args[0] === "gate" && args[1] === "resolve") { find(args[2]).status = "closed"; return; }
		if (args[0] === "close") { find(args[1]).status = "closed"; return; }
		if (args[0] === "update") {
			for (let i = 2; i < args.length; i++) {
				if (args[i] === "--spec-id") run.root.spec_id = args[++i];
				else if (args[i] === "--set-metadata") {
					const [key, value] = (args[++i] ?? "").split("=");
					run.root.metadata = { ...run.root.metadata, [key ?? ""]: value ?? "" };
				} else if (args[i] === "--append-notes") i++;
			}
			return;
		}
		throw new Error(`unexpected command: ${args.join(" ")}`);
	};
	const writes = () => log.filter(args => !["query", "show"].includes(args[0] ?? "") && !(args[0] === "mol" && args[1] === "show"));
	return { log, command, writes };
}

test("missing choice asks before creating any workflow", async () => {
	const command: Command = async args => { if (args[0] === "query") return []; throw new Error("unexpected mutation"); };
	expect(await startSpec(options, command)).toMatchObject({ status: "CHOICE_REQUIRED" });
});

test("resume reuses recorded choice without mutation", async () => {
	const root = runRoot({ spec_dir: `specs/${spec}`, human_approvals: "no", autonomous: "yes" });
	const command: Command = async args => { if (args[0] === "query" || args[0] === "show") return [root]; throw new Error("unexpected mutation"); };
	expect(await startSpec(options, command)).toMatchObject({ status: "READY", root: "run", humanApprovals: "no", autonomous: "yes" });
});

test("contradictory recorded choices cannot advance", async () => {
	const command: Command = async () => [runRoot({ spec_dir: `specs/${spec}`, human_approvals: "no", autonomous: "no" })];
	expect(startSpec(options, command)).rejects.toThrow("Contradictory");
});

test("fresh decline requires separate consent for an existing gated run", async () => {
	const command: Command = async args => { if (args[0] === "query") return [runRoot({ spec_dir: `specs/${spec}` })]; throw new Error("unexpected mutation"); };
	expect(await startSpec({ ...options, approvals: "no", decision: "No routine sign-offs" }, command)).toMatchObject({ status: "MIGRATION_REQUIRED", root: "run" });
});

test("migration refuses a gate without scoped ownership before any write", async () => {
	const root = runRoot({ spec_dir: `specs/${spec}`, human_approvals: "yes", autonomous: "no" });
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

describe("legacy root discovery", () => {
	test("finds a root by spec identity when spec_dir was never recorded, and adopts it instead of pouring", async () => {
		const run = gatedRun();
		const task: Row = { id: "T001", title: "T001 build it", issue_type: "task", spec_id: spec };
		const bonded: Row = { id: "bond", title: "mol-speckit-bugfix", issue_type: "molecule", spec_id: spec };
		const { log, command, writes } = ledger(run, [task, bonded]);
		expect(await startSpec(options, command)).toMatchObject({ status: "CHOICE_REQUIRED", root: "run" });
		expect(await startSpec({ ...options, approvals: "yes", decision: "Keep routine approvals" }, command)).toMatchObject({ status: "READY", root: "run", humanApprovals: "yes" });
		expect(log.some(args => args[0] === "mol" && args[1] === "pour")).toBe(false);
		expect(writes().map(args => args.slice(0, 2))).toEqual([["update", "run"]]);
		expect(run.root.metadata).toMatchObject({ spec_dir: `specs/${spec}`, human_approvals: "yes", autonomous: "no" });
	});

	test("reads the whole spec, not the first page of its beads", async () => {
		const { log, command } = ledger(gatedRun());
		await startSpec(options, command);
		expect(log[0]).toEqual(["query", `spec_id="${spec}"`, "--limit", "0"]);
	});
});

describe("legacy gate verification", () => {
	const enable = { ...options, approvals: "yes" as const, decision: "Keep routine approvals" };
	// spec_dir is recorded, so these runs are found by every root lookup and only the gate check differs.
	const legacy = () => gatedRun({ spec_dir: `specs/${spec}` });
	const refuses = async (damage: (run: ReturnType<typeof gatedRun>) => void, message: string) => {
		const run = legacy();
		damage(run);
		const { command, writes } = ledger(run);
		await expect(startSpec(enable, command)).rejects.toThrow(message);
		expect(writes()).toEqual([]);
	};

	test("allows recording enabled approvals over a complete gate graph", async () => {
		const run = legacy();
		const { command } = ledger(run);
		expect(await startSpec(enable, command)).toMatchObject({ status: "READY", humanApprovals: "yes" });
	});

	test("does not record enabled approvals for a gate detached from the root", () =>
		refuses(run => { run.dependencies = run.dependencies.filter(edge => !(edge.issue_id === "gate-analyze-approval" && edge.type === "parent-child")); }, "ownership"));

	test("does not record enabled approvals when a step no longer waits on its gate", () =>
		refuses(run => { run.dependencies = run.dependencies.filter(edge => !(edge.issue_id === "step-verify-signoff" && edge.depends_on_id === "gate-verify-signoff")); }, "ownership"));

	test("does not record enabled approvals for a sign-off nothing waits on", () =>
		refuses(run => { run.dependencies = run.dependencies.filter(edge => edge.depends_on_id !== "step-clarify-approval"); }, "gates no consumer"));

	test("does not record enabled approvals for a sign-off closed past an open gate", () =>
		refuses(run => { const step = run.issues.find(row => row.id === "step-clarify-approval"); if (step) step.status = "closed"; }, "closed while its gate is open"));

	test("does not record enabled approvals for a gate in an unexpected state", () =>
		refuses(run => { const gate = run.issues.find(row => row.id === "gate-analyze-approval"); if (gate) gate.status = "deferred"; }, "status deferred"));

	test("does not record enabled approvals when a checkpoint is missing", () =>
		refuses(run => { run.issues = run.issues.filter(row => row.id !== "step-verify-signoff"); }, "missing"));
});

describe("recorded metadata validation", () => {
	test("rejects an invalid autonomous value even without human_approvals", async () => {
		const { command, writes } = ledger(gatedRun({ spec_dir: `specs/${spec}`, autonomous: "maybe" }));
		await expect(startSpec({ ...options, approvals: "no", migrate: true, decision: "Decline" }, command)).rejects.toThrow("Invalid recorded choices");
		expect(writes()).toEqual([]);
	});

	test("rejects a spec_dir that names another spec", async () => {
		const { command } = ledger(gatedRun({ spec_dir: "specs/002-other" }));
		await expect(startSpec(options, command)).rejects.toThrow("does not belong");
	});

	test("rejects a recorded autonomous run being given approval gates", async () => {
		const { command, writes } = ledger(gatedRun({ spec_dir: `specs/${spec}`, autonomous: "yes" }));
		await expect(startSpec({ ...options, approvals: "yes", decision: "Add approvals" }, command)).rejects.toThrow("ungated graph");
		expect(writes()).toEqual([]);
	});
});

describe("routine migration", () => {
	test("keeps every prerequisite edge and changes only the routine gate and sign-off", async () => {
		const run = gatedRun({ spec_dir: `specs/${spec}`, human_approvals: "yes", autonomous: "no" });
		const clarify = run.issues.find(row => row.id === "clarify");
		if (clarify) clarify.status = "closed";
		const edgesBefore = JSON.stringify(run.dependencies);
		const { command, writes } = ledger(run);
		const out = await startSpec({ ...options, approvals: "no", migrate: true, decision: "Explicitly migrate routine approvals" }, command);
		expect(out).toMatchObject({ status: "READY", humanApprovals: "no", autonomous: "yes" });
		expect(JSON.stringify(run.dependencies)).toBe(edgesBefore);
		expect(writes().some(args => args[0] === "dep")).toBe(false);
		const closes = writes().filter(args => args[0] === "close");
		// clarify is done, so its sign-off closes normally; the others still wait on open work.
		expect(closes.map(args => [args[1], args.includes("--force")])).toEqual([
			["step-clarify-approval", false],
			["step-analyze-approval", true],
			["step-verify-signoff", true],
		]);
		expect(run.issues.filter(row => row.id.startsWith("gate-")).every(row => row.status === "closed")).toBe(true);
		expect(run.issues.find(row => row.id === "plan")?.status).toBe("open");
	});
});
