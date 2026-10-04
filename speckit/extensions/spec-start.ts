export const APPROVAL_QUESTION = "Require routine human approval checkpoints for this spec/run? Yes or no.";
export const PROFILES = ["speckit-basic", "speckit-lean", "speckit-feature"] as const;
export type Approval = "yes" | "no";
export type Profile = (typeof PROFILES)[number];
export interface StartOptions { spec: string; workspace: string; profile?: Profile; root?: string; approvals?: Approval; decision?: string; migrate?: boolean; }
export type Command = (args: string[]) => Promise<unknown>;
interface Issue { id: string; title?: string; description?: string; status?: string; await_type?: string; metadata?: Record<string, unknown>; }
export interface StartResult { status: "READY" | "CHOICE_REQUIRED" | "MIGRATION_REQUIRED"; question?: string; root?: string; humanApprovals?: Approval; autonomous?: Approval; text: string; }

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Beads JSON object");
	return value as Record<string, unknown>;
}
function payload(value: unknown): unknown {
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
			await_type: typeof row.await_type === "string" ? row.await_type : undefined,
			metadata: row.metadata === undefined || row.metadata === null ? undefined : object(row.metadata) };
	});
}
function approval(value: unknown): Approval | undefined {
	if (value === undefined) return undefined;
	if (value !== "yes" && value !== "no") throw new Error("Approval choice must be exactly yes or no");
	return value;
}
const ROUTINE = [
	["clarify-approval", "clarify approval"],
	["analyze-approval", "analyze approval"],
	["verify-signoff", "verify sign-off"],
] as const;

async function migrateRoutine(root: Issue, options: StartOptions, command: Command): Promise<void> {
	const graph = object(payload(await command(["mol", "show", root.id])));
	const children = issueList(graph.issues);
	if (!Array.isArray(graph.dependencies)) throw new Error("Molecule graph has no dependency rows");
	const edges = graph.dependencies.map(object);
	const resolutions: { gate: string; step: string; close: boolean; resolve: boolean; prerequisites: string[] }[] = [];
	for (const [name, title] of ROUTINE) {
		const steps = children.filter(row => row.title === `${title} ${options.spec}`);
		if (steps.length > 1) throw new Error(`Ambiguous routine step ${name}; migration refused`);
		const step = steps[0];
		if (!step) continue;
		const gates = children.filter(row => row.await_type === "human" && row.description === `Async gate for step ${name}`);
		if (gates.length > 1) throw new Error(`Ambiguous routine gate ${name}; migration refused`);
		const gate = gates[0];
		if (!gate) throw new Error(`Routine step ${name} has no verified gate; migration refused`);
		const blocking = edges.some(edge => edge.type === "blocks" && edge.issue_id === step.id && edge.depends_on_id === gate.id);
		const parent = edges.some(edge => edge.type === "parent-child" && edge.issue_id === gate.id && edge.depends_on_id === root.id);
		if (!blocking || !parent) throw new Error(`Unverified routine gate ownership for ${name}; migration refused`);
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
		resolutions.push({ gate: gate.id, step: step.id, close: step.status !== "closed", resolve: gate.status !== "closed", prerequisites: prerequisites as string[] });
	}
	await command(["update", root.id, "--append-notes", `Explicit routine-approval migration consent: ${options.decision}. Selected gates: ${resolutions.map(row => row.gate).join(", ") || "none"}. Safety/provider confirmations remain mandatory.`]);
	for (const row of resolutions) {
		if (row.resolve) await command(["gate", "resolve", row.gate]);
		// Only the routine sign-off loses these edges; every consumer keeps its direct review dependency.
		for (const prerequisite of row.prerequisites) await command(["dep", "remove", row.step, prerequisite]);
		if (row.close) await command(["close", row.step, "--reason", `Explicit routine-approval migration authorized on ${root.id}; gate ${row.gate} resolved. Reviews/tests/safety remain required.`]);
	}
	const after = issueList(object(payload(await command(["mol", "show", root.id]))).issues);
	if (resolutions.some(row => after.find(issue => issue.id === row.gate)?.status !== "closed" || after.find(issue => issue.id === row.step)?.status !== "closed")) throw new Error("Routine migration readback failed; do not record approvals as declined");
}

export async function startSpec(options: StartOptions, command: Command): Promise<StartResult> {
	if (!/^[0-9]{3}-[a-z0-9-]+$/.test(options.spec)) throw new Error("Spec must be NNN-slug");
	const profile = options.profile ?? "speckit-feature";
	if (!PROFILES.includes(profile)) throw new Error("Unknown SpecKit profile");
	const requested = approval(options.approvals);
	const roots = issueList(await command(["query", `spec_id="${options.spec}"`])).filter(row => row.metadata?.spec_dir === `specs/${options.spec}`);
	if (roots.length > 1 && !options.root) throw new Error("Multiple runs exist; select an explicit root");
	let root = options.root ? issueList(await command(["show", options.root]))[0] : roots[0];
	if (options.root && (!root || root.metadata?.spec_dir !== `specs/${options.spec}`)) throw new Error("Root does not belong to this spec");
	const saved = approval(root?.metadata?.human_approvals);
	if (saved !== undefined && approval(root?.metadata?.autonomous) !== (saved === "yes" ? "no" : "yes")) throw new Error("Contradictory recorded choices; explicit correction required");
	if (saved === "no" && requested === "yes") throw new Error("Cannot add approval gates to an existing ungated graph; start a new explicitly approved run");
	const selected = requested ?? saved;
	if (!selected) return { status: "CHOICE_REQUIRED", root: root?.id, question: APPROVAL_QUESTION, text: APPROVAL_QUESTION };
	const migration = root !== undefined && selected === "no" && saved !== "no";
	if (root && saved === undefined && selected === "yes") {
		const legacy = issueList(object(payload(await command(["mol", "show", root.id]))).issues);
		if (!ROUTINE.every(([name, title]) => legacy.some(row => row.title === `${title} ${options.spec}`)
			&& legacy.some(row => row.await_type === "human" && row.description === `Async gate for step ${name}`))) {
			throw new Error("Legacy run has no complete routine approval graph; cannot claim approvals are enabled");
		}
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
