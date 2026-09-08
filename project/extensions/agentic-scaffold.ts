import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function agenticScaffold(pi: ExtensionAPI): void {
	const z = pi.zod;
	const script = fileURLToPath(new URL("../skills/agentic-scaffold/scripts/setup.py", import.meta.url));
	pi.registerCommand("agentic-scaffold", {
		description: "Scaffold project agent instructions, watchdogs, context indexes, MCP, and prek hooks",
		handler: async (args) => {
			pi.sendUserMessage(`Use skill://agentic-scaffold to scaffold this project's agentic tooling. ${args}`);
		},
	});
	pi.registerTool({
		name: "agentic_scaffold",
		label: "Agentic project scaffolding",
		description: "Inspect or install project-local OMP instructions, Graphify MCP, scoped Repomix XML, and preserving prek refresh hooks. Apply requires evidence-derived notes and explicit include patterns.",
		parameters: z.object({
			action: z.enum(["inspect", "apply"]),
			root: z.string().min(1).describe("Existing Git repository root"),
			notesFile: z.string().optional().describe("Apply: JSON file containing agents and watchdog instruction text"),
			include: z.array(z.string().min(1)).optional().describe("Apply: explicit Repomix include patterns"),
			installTools: z.boolean().optional().describe("Install missing graphifyy[mcp], prek, and Repomix; requires installation authority"),
			docsBackend: z.enum(["ollama", "openai", "claude", "gemini", "kimi", "deepseek", "azure", "bedrock"]).optional(),
			docsModel: z.string().min(1).optional(),
			timeout: z.number().int().min(10).max(1800).optional(),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["run", "--script", script, params.action, "--root", resolve(ctx.cwd, params.root)];
			if (params.notesFile) args.push("--notes", resolve(ctx.cwd, params.notesFile));
			for (const pattern of params.include ?? []) args.push("--include", pattern);
			if (params.installTools) args.push("--install-tools");
			if (params.docsBackend) args.push("--docs-backend", params.docsBackend);
			if (params.docsModel) args.push("--docs-model", params.docsModel);
			if (params.timeout) args.push("--timeout", String(params.timeout));
			try {
				const result = await pi.exec("uv", args, { signal, timeout: ((params.timeout ?? 120) * 3 + 600) * 1000 });
				return {
					content: [{ type: "text" as const, text: `${result.stdout}\n${result.stderr}`.trim() }],
					isError: result.code !== 0,
					details: { code: result.code, action: params.action },
				};
			} catch (error) {
				return { content: [{ type: "text" as const, text: `Agentic scaffolding failed: ${String(error)}` }], isError: true };
			}
		},
	});
}
