export const APPROVAL_QUESTION = "Require routine human approval checkpoints for this spec/run? Yes or no.";
export const PROFILES = ["speckit-basic", "speckit-lean", "speckit-feature"] as const;
export type Approval = "yes" | "no";
export type Profile = (typeof PROFILES)[number];
export interface StartOptions { spec: string; workspace: string; profile?: Profile; root?: string; approvals?: Approval; decision?: string; migrate?: boolean; }
export type Command = (args: string[]) => Promise<unknown>;
interface Issue { id: string; title?: string; description?: string; status?: string; issue_type?: string; spec_id?: string; await_type?: string; metadata?: Record<string, unknown>; }
export interface StartResult { status: "READY" | "CHOICE_REQUIRED" | "MIGRATION_REQUIRED"; question?: string; root?: string; humanApprovals?: Approval; autonomous?: Approval; text: string; }

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Beads JSON object");
	return value as Record<string, unknown>;
}
export function payload(value: unknown): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value) && "data" in value) return object(value).data;
	return value;
}
function issueList(value: unknown): Issue[] {
	const data = payload(value);
	if (!Array.isArray(data)) throw new Error("Expected a Beads issue list");
	return data.map(item => {
		const row = object(item);
		if (typeof row.id !== "string" || !row.id) throw new Error("Issue has no id");
		return { id: row.id, title: typeof row.title === "string" ? row.title : undefined,
			description: typeof row.description === "string" ? row.description : undefined,
			status: typeof row.status === "string" ? row.status : undefined,
			issue_type: typeof row.issue_type === "string" ? row.issue_type : undefined,
			spec_id: typeof row.spec_id === "string" ? row.spec_id : undefined,
			await_type: typeof row.await_type === "string" ? row.await_type : undefined,
			metadata: row.metadata === undefined || row.metadata === null ? undefined : object(row.metadata) };
	});
}
function approval(value: unknown): Approval | undefined {
	if (value === undefined) return undefined;
	if (value !== "yes" && value !== "no") throw new Error("Approval choice must be exactly yes or no");
	return value;
}
const inverse = (value: Approval): Approval => (value === "yes" ? "no" : "yes");
const ROUTINE = [
	["clarify-approval", "clarify approval"],
	["analyze-approval", "analyze approval"],
	["verify-signoff", "verify sign-off"],
] as const;

/** A run root: the profile-named root a pour creates, typed molecule (epic is accepted for legacy runs). */
function isRunRoot(row: Issue): boolean {
	return (row.issue_type === "molecule" || row.issue_type === "epic") && PROFILES.some(profile => profile === row.title);
}

/**
 * The choice recorded on a run root, with every present field validated on its own:
 * `spec_dir` must name this spec, `human_approvals` and `autonomous` must each be exactly
 * yes or no, and a recorded `human_approvals` needs the opposite `autonomous`.
 */
function recordedChoice(root: Issue | undefined, spec: string): { saved?: Approval; mode?: Approval } {
	const metadata = root?.metadata ?? {};
	if (metadata.spec_dir !== undefined && metadata.spec_dir !== `specs/${spec}`) throw new Error("Root does not belong to this spec");
	let saved: Approval | undefined;
	let mode: Approval | undefined;
	try {
		saved = approval(metadata.human_approvals);
		mode = approval(metadata.autonomous);
	} catch {
		throw new Error("Invalid recorded choices: human_approvals and autonomous must be exactly yes or no; explicit correction required");
	}
	if (saved !== undefined && mode !== inverse(saved)) throw new Error("Contradictory recorded choices; explicit correction required");
	return { saved, mode };
}

interface Graph { children: Issue[]; edges: Record<string, unknown>[]; }
interface Checkpoint { name: string; step: Issue; gate: Issue; }

async function moleculeGraph(root: Issue, command: Command): Promise<Graph> {
	const graph = object(payload(await command(["mol", "show", root.id])));
	if (!Array.isArray(graph.dependencies)) throw new Error("Molecule graph has no dependency rows");
	return { children: issueList(graph.issues), edges: graph.dependencies.map(object) };
}

function hasEdge(edges: Record<string, unknown>[], type: string, from: string, to: string): boolean {
	return edges.some(edge => edge.type === type && edge.issue_id === from && edge.depends_on_id === to);
}

/**
 * The routine approval checkpoints of `root`, each verified as a pour creates it: one
 * approval step and one human gate, both children of the root, the step blocked by its
 * gate, at least one consumer waiting on the step, and a step closed only after its gate.
 * With `required` every checkpoint must exist; otherwise a missing step is skipped.
 */
function routineCheckpoints(root: Issue, spec: string, graph: Graph, required: boolean, refusal: string): Checkpoint[] {
	const { children, edges } = graph;
	const checkpoints: Checkpoint[] = [];
	for (const [name, title] of ROUTINE) {
		const steps = children.filter(row => row.title === `${title} ${spec}`);
		if (steps.length > 1) throw new Error(`Ambiguous routine step ${name}; ${refusal}`);
		const step = steps[0];
		if (!step) {
			if (required) throw new Error(`Routine step ${name} is missing; ${refusal}`);
			continue;
		}
		const gates = children.filter(row => row.await_type === "human" && row.description === `Async gate for step ${name}`);
		if (gates.length > 1) throw new Error(`Ambiguous routine gate ${name}; ${refusal}`);
		const gate = gates[0];
		if (!gate) throw new Error(`Routine step ${name} has no verified gate; ${refusal}`);
		if (!hasEdge(edges, "blocks", step.id, gate.id) || !hasEdge(edges, "parent-child", gate.id, root.id) || !hasEdge(edges, "parent-child", step.id, root.id)) {
			throw new Error(`Unverified routine gate ownership for ${name}; ${refusal}`);
		}
		if (!edges.some(edge => edge.type === "blocks" && edge.depends_on_id === step.id)) throw new Error(`Routine step ${name} gates no consumer; ${refusal}`);
		if (gate.status !== "open" && gate.status !== "closed") throw new Error(`Routine gate ${name} has status ${gate.status ?? "none"}; ${refusal}`);
		if (step.status === "closed" && gate.status !== "closed") throw new Error(`Routine step ${name} is closed while its gate is open; ${refusal}`);
		checkpoints.push({ name, step, gate });
	}
	return checkpoints;
}

async function migrateRoutine(root: Issue, options: StartOptions, command: Command): Promise<void> {
	const graph = await moleculeGraph(root, command);
	const { children, edges } = graph;
	const resolutions: { gate: string; step: string; close: boolean; resolve: boolean; blocked: boolean }[] = [];
	for (const { name, step, gate } of routineCheckpoints(root, options.spec, graph, false, "migration refused")) {
		const extraGates = edges.filter(edge => edge.type === "blocks" && edge.issue_id === step.id && edge.depends_on_id !== gate.id)
			.map(edge => children.find(child => child.id === edge.depends_on_id))
			.filter(child => child?.await_type !== undefined && child.status !== "closed");
		if (extraGates.length) throw new Error(`Additional safety/provider gate blocks ${name}; migration refused`);
		const prerequisites = edges.filter(edge => edge.type === "blocks" && edge.issue_id === step.id && edge.depends_on_id !== gate.id)
			.map(edge => edge.depends_on_id);
		const consumers = edges.filter(edge => edge.type === "blocks" && edge.depends_on_id === step.id);
		if (prerequisites.some(pre => typeof pre !== "string" || !children.some(child => child.id === pre && child.await_type === undefined)
			|| consumers.some(consumer => !edges.some(edge => edge.type === "blocks" && edge.issue_id === consumer.issue_id && edge.depends_on_id === pre)))) {
			throw new Error(`Cannot waive ${name} without preserving every consumer's verification dependencies`);
		}
		const blocked = prerequisites.some(pre => children.find(child => child.id === pre)?.status !== "closed");
		resolutions.push({ gate: gate.id, step: step.id, close: step.status !== "closed", resolve: gate.status !== "closed", blocked });
	}
	await command(["update", root.id, "--append-notes", `Explicit routine-approval migration consent: ${options.decision}. Selected gates: ${resolutions.map(row => row.gate).join(", ") || "none"}. Safety/provider confirmations remain mandatory.`]);
	for (const row of resolutions) {
		if (row.resolve) await command(["gate", "resolve", row.gate]);
		// Prerequisite edges stay as history. Every consumer also waits on each prerequisite
		// directly (checked above), so force-closing a still-blocked sign-off releases nothing early.
		if (row.close) await command(["close", row.step, ...(row.blocked ? ["--force"] : []), "--reason", `Explicit routine-approval migration authorized on ${root.id}; gate ${row.gate} resolved. Reviews/tests/safety remain required.`]);
	}
	const after = issueList(object(payload(await command(["mol", "show", root.id]))).issues);
	if (resolutions.some(row => after.find(issue => issue.id === row.gate)?.status !== "closed" || after.find(issue => issue.id === row.step)?.status !== "closed")) throw new Error("Routine migration readback failed; do not record approvals as declined");
}

export async function startSpec(options: StartOptions, command: Command): Promise<StartResult> {
	if (!/^[0-9]{3}-[a-z0-9-]+$/.test(options.spec)) throw new Error("Spec must be NNN-slug");
	const profile = options.profile ?? "speckit-feature";
	if (!PROFILES.includes(profile)) throw new Error("Unknown SpecKit profile");
	const requested = approval(options.approvals);
	// Candidates by spec identity alone, so a legacy root without spec_dir is still found;
	// its metadata is validated only after one root is selected.
	const roots = issueList(await command(["query", `spec_id="${options.spec}"`, "--limit", "0"])).filter(isRunRoot);
	if (roots.length > 1 && !options.root) throw new Error("Multiple runs exist; select an explicit root");
	let root = options.root ? issueList(await command(["show", options.root]))[0] : roots[0];
	if (options.root && (!root || root.spec_id !== options.spec || !isRunRoot(root))) throw new Error("Root does not belong to this spec");
	const { saved, mode: recordedMode } = recordedChoice(root, options.spec);
	const recorded = saved ?? (recordedMode === undefined ? undefined : inverse(recordedMode));
	if (recorded === "no" && requested === "yes") throw new Error("Cannot add approval gates to an existing ungated graph; start a new explicitly approved run");
	const selected = requested ?? saved;
	if (!selected) return { status: "CHOICE_REQUIRED", root: root?.id, question: APPROVAL_QUESTION, text: APPROVAL_QUESTION };
	const migration = root !== undefined && selected === "no" && saved !== "no";
	if (root && saved === undefined && selected === "yes") {
		routineCheckpoints(root, options.spec, await moleculeGraph(root, command), true, "legacy run cannot claim approvals are enabled");
	}
	if (root && migration && options.migrate !== true) {
		const question = `Explicitly migrate existing run ${root.id} to omit routine approvals, resolving only its routine formula approval gates while preserving history? Yes or no.`;
		return { status: "MIGRATION_REQUIRED", root: root.id, question, text: question };
	}
	if ((saved === undefined || migration) && !options.decision?.trim()) throw new Error("Record the explicit user decision before creating or migrating a workflow");
	if (root && migration) await migrateRoutine(root, options, command);
	const mode = selected === "yes" ? "no" : "yes";
	if (!root) {
		const poured = object(payload(await command(["mol", "pour", profile, "--var", `feature=${options.spec}`, "--var", `autonomous=${mode}`])));
		if (typeof poured.new_epic_id !== "string") throw new Error("Pour returned no new_epic_id; inspect the created run before retrying");
		root = { id: poured.new_epic_id };
	}
	if (saved === undefined || migration) await command(["update", root.id, "--spec-id", options.spec, "--set-metadata", `spec_dir=specs/${options.spec}`, "--set-metadata", `human_approvals=${selected}`, "--set-metadata", `autonomous=${mode}`, "--append-notes", `Routine approvals: ${selected}. Explicit user decision: ${options.decision}`]);
	const confirmed = issueList(await command(["show", root.id]))[0];
	if (confirmed?.metadata?.human_approvals !== selected || confirmed.metadata.autonomous !== mode) throw new Error(`Approval choice readback failed for ${root.id}; do not advance`);
	return { status: "READY", root: root.id, humanApprovals: selected, autonomous: mode, text: `${options.spec} / ${root.id}: human approvals=${selected}; autonomous=${mode}. Routine clarify, analyze, and verification sign-offs ${selected === "yes" ? "enabled" : "omitted"}. Reviews, verification, tests, and consequential safety/provider confirmations remain required. Only actual dependency consumers wait.` };
}
