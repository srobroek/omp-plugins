import { homedir } from "node:os";
import { join, basename } from "node:path";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_HANDOVER_DIR = join(
	homedir(),
	".local",
	"state",
	"agentic-tools",
	"handovers",
);

export type HandoverParams = {
	cwd?: string;
	outDir?: string;
	project?: string;
	branch?: string;
	task?: string;
	repoRoot?: string;
	worktree?: string;
	beads?: string;
};

export function slug(value: string): string {
	let s = value.trim().toLowerCase();
	s = s.replace(/[\\/\s]+/g, "-");
	s = s.replace(/[^a-z0-9._-]+/g, "-");
	s = s.replace(/-{2,}/g, "-");
	s = s.replace(/^[.\-_]+|[.\-_]+$/g, "");
	return s || "handover";
}

export function yamlScalar(value: string): string {
	return JSON.stringify(String(value));
}

function runGit(args: string[], cwd: string): string | null {
	try {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: 10_000,
		});
		if (proc.exitCode !== 0) return null;
		const value = proc.stdout.toString().trim();
		return value || null;
	} catch {
		return null;
	}
}

export function discover(cwd: string): {
	project: string;
	repo_root: string;
	worktree: string;
	branch: string;
} {
	const repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
	let branch = runGit(["branch", "--show-current"], cwd);
	if (!branch) {
		const shortSha = runGit(["rev-parse", "--short", "HEAD"], cwd);
		branch = shortSha ? `detached-${shortSha}` : "unknown-branch";
	}
	const worktree = repoRoot ?? cwd;
	return {
		project: basename(worktree),
		repo_root: repoRoot ?? cwd,
		worktree,
		branch,
	};
}

export function parseBeads(raw?: string): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((b) => b.trim())
		.filter(Boolean);
}

export function buildContent(opts: {
	project: string;
	repoRoot: string;
	worktree: string;
	branch: string;
	task: string;
	beads?: string[];
}): string {
	const updated = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	const beadsLine =
		opts.beads && opts.beads.length
			? `beads: ${JSON.stringify(opts.beads.map(String))}\n`
			: "";
	const frontmatter = `---
project: ${yamlScalar(opts.project)}
repo_root: ${yamlScalar(opts.repoRoot)}
worktree: ${yamlScalar(opts.worktree)}
branch: ${yamlScalar(opts.branch)}
task: ${yamlScalar(opts.task)}
${beadsLine}updated: ${yamlScalar(updated)}
---

# Handover: ${opts.project} / ${opts.task || opts.branch}
`;
	if (opts.beads && opts.beads.length) {
		const beadItems = opts.beads.map((b) => `- ${b}: TODO where work stopped`).join("\n");
		return (
			frontmatter +
			`
## Summary

- TODO

## Read First

- TODO

## Active Beads

${beadItems}

Task state lives in beads: run \`bd ready\` and \`bd list --status in_progress\`.

## Decisions

- TODO

## Runtime State

None known

## Avoid / Do Not Redo

None

## Next Session Prompt

TODO: Continue from this handover. Run \`bd show\` on the active beads and fresh git status, then proceed with the next concrete step.
`
		);
	}
	return (
		frontmatter +
		`
## Summary

- TODO

## Read First

- TODO

## Changed Areas

- TODO

## Complete

- TODO

## Incomplete

- TODO

## Blockers

None known

## Decisions

- TODO

## Verification / Commands

Not run

## Runtime State

None known

## Avoid / Do Not Redo

None

## Next Session Prompt

TODO: Continue from this handover. First inspect the referenced files and fresh git status, then proceed with the next concrete step.
`
	);
}

export function writePrivate(path: string, content: string): void {
	const parent = path.slice(0, path.lastIndexOf("/"));
	try {
		mkdirSync(parent, { recursive: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`cannot create handover directory ${parent}: ${message}`);
	}
	try {
		chmodSync(parent, 0o700);
	} catch {
		/* ignore */
	}
	const tmp = join(parent, `.${basename(path)}.${process.pid}.${Date.now()}`);
	try {
		writeFileSync(tmp, content, "utf8");
		try {
			chmodSync(tmp, 0o600);
		} catch {
			/* ignore */
		}
		renameSync(tmp, path);
		try {
			chmodSync(path, 0o600);
		} catch {
			/* ignore */
		}
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`cannot write handover into ${parent}: ${message}`);
	}
}

export function createHandover(params: HandoverParams): { ok: boolean; path?: string; error?: string } {
	const cwd = params.cwd ?? process.cwd();
	const discovered = discover(cwd);
	const project = params.project ?? discovered.project;
	const branch = params.branch ?? discovered.branch;
	const task = params.task ?? branch;
	const repoRoot = params.repoRoot ?? discovered.repo_root;
	const worktree = params.worktree ?? discovered.worktree;
	const beads = parseBeads(params.beads);
	const filename = `${slug(project)}__${slug(task)}.md`;
	const outDir = params.outDir ?? DEFAULT_HANDOVER_DIR;
	const path = join(outDir.replace(/^~(?=\/|$)/, homedir()), filename);
	const content = buildContent({
		project,
		repoRoot,
		worktree,
		branch,
		task,
		beads: beads.length ? beads : undefined,
	});
	try {
		writePrivate(path, content);
		return { ok: true, path };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

export default function handoverTool(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.registerTool({
		name: "new_handover",
		label: "Scaffold handover",
		description:
			"Create a handover markdown file under the shared store (~/.local/state/agentic-tools/handovers/) with slugs, frontmatter, and 0700/0600 perms.",
		parameters: z.object({
			cwd: z.string().optional().describe("Project directory to inspect"),
			outDir: z.string().optional().describe("Handover output directory"),
			project: z.string().optional(),
			branch: z.string().optional(),
			task: z.string().optional(),
			repoRoot: z.string().optional(),
			worktree: z.string().optional(),
			beads: z
				.string()
				.optional()
				.describe("Comma-separated active bead IDs; switches to narrative-only beads layout"),
		}),
		execute: async (_id, params: HandoverParams) => {
			const result = createHandover(params);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `error: ${result.error}` }],
					details: { ok: false, error: result.error },
				};
			}
			return {
				content: [{ type: "text", text: result.path ?? "" }],
				details: { ok: true, path: result.path },
			};
		},
	});
}

