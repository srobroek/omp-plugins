import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const SCRIPT = new URL(
	"../skills/write-agentic/scripts/lint.py",
	import.meta.url,
).pathname;

const TIMEOUT_MS = 60_000;

type LintParams = { paths: string[] };

type Finding = {
	path: string;
	kind?: string;
	severity: string;
	code?: string;
	message: string;
};

function collectFiles(entry: string): string[] {
	let st;
	try {
		st = statSync(entry);
	} catch {
		return [entry];
	}
	if (st.isFile()) {
		return [entry];
	}
	if (!st.isDirectory()) {
		return [entry];
	}
	const out: string[] = [];
	const stack = [entry];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			out.push(dir);
			continue;
		}
		for (const name of names) {
			const child = join(dir, name);
			let childSt;
			try {
				childSt = statSync(child);
			} catch {
				continue;
			}
			if (childSt.isDirectory()) {
				stack.push(child);
			} else if (childSt.isFile() && name.endsWith(".md")) {
				out.push(child);
			}
		}
	}
	return out;
}

function parseFindings(stdout: string): Finding[] {
	const findings: Finding[] = [];
	for (const line of stdout.split("\n")) {
		const ok = line.match(/^(.+) \[([^\]]+)\]: OK(?: \(with overrides\))?$/);
		if (ok) {
			findings.push({ path: ok[1] ?? "", kind: ok[2], severity: "OK", message: line });
			continue;
		}
		const hit = line.match(
			/^(.+) \[([^\]]+)\] (ERROR|WARN|OVERRIDDEN) ([A-Z]\d+): (.+)$/,
		);
		if (hit) {
			findings.push({
				path: hit[1] ?? "",
				kind: hit[2],
				severity: hit[3] ?? "",
				code: hit[4],
				message: hit[5] ?? "",
			});
			continue;
		}
		const missing = line.match(/^(.+): not a file$/);
		if (missing) {
			findings.push({
				path: missing[1] ?? "",
				severity: "ERROR",
				message: "not a file",
			});
		}
	}
	return findings;
}

function spawnLint(files: string[], cwd?: string): {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	error?: string;
} {
	try {
		const proc = Bun.spawnSync(["python3", SCRIPT, ...files], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: TIMEOUT_MS,
		});
		return {
			ok: proc.exitCode === 0,
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, exitCode: null, stdout: "", stderr: "", error: message };
	}
}

export default function agenticLintTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "agentic_lint",
		label: "Lint agentic assets",
		description:
			"Lint skill/rule/agent markdown against the write-agentic format contract. Pass files or directories.",
		parameters: z.object({
			paths: z
				.array(z.string())
				.describe("Skill, rule, or agent markdown files or directories"),
		}),
		approval: "read",
		execute: async (_toolCallId, params: LintParams, _signal, _onUpdate, ctx) => {
			const cwd = ctx?.cwd;
			const files = params.paths.flatMap(collectFiles);
			if (files.length === 0) {
				return {
					content: [{ type: "text", text: "agentic_lint: no markdown files in paths" }],
					details: { ok: false, error: "no files", paths: params.paths },
				};
			}
			const result = spawnLint(files, cwd);
			if (result.error) {
				return {
					content: [
						{
							type: "text",
							text: `agentic_lint failed to spawn: ${result.error}`,
						},
					],
					details: { ok: false, error: result.error, paths: params.paths },
				};
			}
			const findings = parseFindings(result.stdout);
			const errors = findings.filter((f) => f.severity === "ERROR").length;
			const warns = findings.filter((f) => f.severity === "WARN").length;
			const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
			const summary =
				combined.trim() ||
				`agentic_lint exit ${result.exitCode} (errors=${errors} warns=${warns})`;
			return {
				content: [{ type: "text", text: summary }],
				details: {
					ok: result.ok,
					exitCode: result.exitCode,
					errors,
					warns,
					files,
					findings,
					stdout: result.stdout,
					stderr: result.stderr,
				},
			};
		},
	});
}
