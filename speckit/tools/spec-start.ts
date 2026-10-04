import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { Approval, Profile } from "../extensions/spec-start.ts";
import { PROFILES } from "../extensions/spec-start.ts";
import type { RuntimeOptions } from "../extensions/spec-start-runtime.ts";
import { runSpecStart } from "../extensions/spec-start-runtime.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: {
		spec: { type: "string" }, workspace: { type: "string", default: process.cwd() },
		profile: { type: "string", default: "speckit-feature" }, root: { type: "string" },
		approvals: { type: "string" }, decision: { type: "string" }, migrate: { type: "boolean", default: false },
		"beads-plugin": { type: "string" },
	} });
	if (!values.spec || !PROFILES.includes(values.profile as Profile)) throw new Error("Use --spec NNN-slug and --profile speckit-basic|speckit-lean|speckit-feature");
	if (values.approvals !== undefined && values.approvals !== "yes" && values.approvals !== "no") throw new Error("--approvals must be exactly yes or no");
	let options: RuntimeOptions = { spec: values.spec, workspace: values.workspace, profile: values.profile as Profile, root: values.root, approvals: values.approvals as Approval | undefined, decision: values.decision, migrate: values.migrate, beadsPlugin: values["beads-plugin"] };
	let result = await runSpecStart(options);
	while (result.status !== "READY") {
		if (!process.stdin.isTTY) throw new Error(`${result.question} Supply --approvals yes|no and --decision for explicit noninteractive selection; existing gated-run migration also requires --migrate.`);
		const input = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = await input.question(`${result.question} `);
			if (answer !== "yes" && answer !== "no") throw new Error("Answer exactly yes or no; no new workflow was created");
			if (result.status === "MIGRATION_REQUIRED") {
				if (answer === "no") throw new Error("Migration declined; existing approvals retained");
				options = { ...options, migrate: true, decision: `${options.decision ?? ""} Explicitly answered yes to: ${result.question}` };
			} else options = { ...options, approvals: answer, decision: `User answered ${answer} to: ${result.question}` };
			result = await runSpecStart(options);
		} finally { input.close(); }
	}
	console.log(result.text);
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
