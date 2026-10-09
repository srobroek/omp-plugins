import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { PROFILES } from "./spec-start.ts";
import type { RuntimeOptions } from "./spec-start-runtime.ts";
import { IncompleteStart, runSpecStart } from "./spec-start-runtime.ts";

export default function speckitStartTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "speckit_start",
		label: "Start or resume a spec workflow",
		description: "Ask for an explicit routine approval choice before pouring, persist/read back the answer, reuse it on resume, and require separate consent for existing gated-run migration. Reviews/tests/safety remain required. A store-lock wait that runs out, a Beads command past its bound, or cancellation returns INCOMPLETE with the step reached and whether a pour was issued; inspect the run before retrying.",
		parameters: pi.zod.object({
			spec: pi.zod.string().describe("NNN-slug spec identity"),
			workspace: pi.zod.string().describe("Canonical repository root containing .beads"),
			profile: pi.zod.enum(PROFILES).optional(),
			root: pi.zod.string().optional().describe("Existing run root; required if multiple runs exist"),
			approvals: pi.zod.enum(["yes", "no"]).optional().describe("Explicit user answer, never inferred from unattended mode"),
			decision: pi.zod.string().optional().describe("Explicit user decision to retain in history"),
			migrate: pi.zod.boolean().optional().describe("Separate explicit authorization to migrate an existing gated run"),
			beadsPlugin: pi.zod.string().optional().describe("Installed @srobroek/beads package root when normal package resolution is unavailable"),
		}) as unknown as TSchema,
		execute: async (_id, options: RuntimeOptions, signal) => {
			try {
				const result = await runSpecStart(options, signal);
				return { content: [{ type: "text", text: result.text }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: error instanceof IncompleteStart ? error.details : { status: "FAIL" }, isError: true };
			}
		},
	});
}
