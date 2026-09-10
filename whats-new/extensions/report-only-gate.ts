import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };

/** Dependency manifests. Lowercased basenames; macOS filesystems fold case. */
const MANIFESTS: Record<string, true> = {
	"package.json": true, "cargo.toml": true, "pyproject.toml": true,
	"go.mod": true, "go.sum": true, "requirements.txt": true,
	"composer.json": true, "gemfile": true, "pipfile": true,
	"package-lock.json": true, "npm-shrinkwrap.json": true, "pnpm-lock.yaml": true,
};

/** Any `*.lock` (uv, Cargo, poetry, yarn) plus bun's `bun.lock`/`bun.lockb`. */
const LOCKFILE = /\.lock$|^bun\.lock/;

/** Package-manager verbs that install, add, or move a version. */
const INSTALLER =
	/(?:^|[\s;&|(`])(?:(?:npm|pnpm|bun|yarn)\s+(?:install|add|up(?:grade)?|update)|pip3?\s+install|cargo\s+(?:add|install|update)|go\s+get|uv\s+(?:add|pip\s+install)|poetry\s+(?:add|update))\b/i;

const SKILL_READ = /^skill:\/\/whats-new(?:\/|$)|whats-new\/SKILL\.md/i;
const HANDOVER_READ = /^skill:\/\/dep-update(?:\/|$)|dep-update\/SKILL\.md/i;

export const DENY_REASON =
	"blocked by whats-new (research-only): this session loaded the whats-new skill, which reports what changed " +
	"between two versions and changes nothing itself. Do not edit dependency manifests or lockfiles and do not " +
	"run installers or upgrade commands while researching -- the finding belongs in the report. If the user " +
	"actually wants the upgrade applied, that is dep-update's job: read `skill://dep-update` and run its " +
	"dep_scan/dep_apply confirm loop (reading it releases this gate, not the per-bump approval).";

/** Armed for the rest of the session once the skill is loaded. */
export interface GateState {
	armed: boolean;
}

export function createState(): GateState {
	return { armed: false };
}

/**
 * Every path this call would write. Hashline `edit` carries no `path` when a
 * patch spans several files, so the derived `paths` array is the only complete
 * target list and both shapes must be read.
 */
export function targetPaths(input: ToolCallEvent["input"]): string[] {
	const out: string[] = [];
	// `in` narrows one literal key at a time, so the two spellings stay unrolled.
	if ("path" in input && typeof input.path === "string" && input.path.length > 0) {
		out.push(input.path);
	}
	if ("file_path" in input && typeof input.file_path === "string" && input.file_path.length > 0) {
		out.push(input.file_path);
	}
	if ("paths" in input && Array.isArray(input.paths)) {
		for (const p of input.paths) if (typeof p === "string" && p.length > 0) out.push(p);
	}
	return out;
}

/** Reading the skill body -- or any of its references -- starts a research pass. */
export function armsGate(raw: string): boolean {
	return SKILL_READ.test(raw.replaceAll("\\", "/").trim());
}

/** dep-update owns real upgrades, so loading it hands the session over. */
export function disarmsGate(raw: string): boolean {
	return HANDOVER_READ.test(raw.replaceAll("\\", "/").trim());
}

export function isDependencyFile(raw: string): boolean {
	const path = raw.replaceAll("\\", "/").trim();
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	return Object.hasOwn(MANIFESTS, name) || LOCKFILE.test(name);
}

export function decideToolCall(
	state: GateState,
	toolName: string,
	input: ToolCallEvent["input"],
): { block: true; reason: string } | undefined {
	if (toolName === "read") {
		for (const path of targetPaths(input)) {
			if (disarmsGate(path)) state.armed = false;
			else if (armsGate(path)) state.armed = true;
		}
		return;
	}
	if (!state.armed) return;
	if (toolName === "dep_apply") return { block: true, reason: DENY_REASON };
	if (Object.hasOwn(EDIT_TOOLS, toolName)) {
		if (targetPaths(input).some(isDependencyFile)) return { block: true, reason: DENY_REASON };
		return;
	}
	if (toolName === "bash") {
		const command = "command" in input ? input.command : undefined;
		if (typeof command === "string" && INSTALLER.test(command)) {
			return { block: true, reason: DENY_REASON };
		}
	}
	return;
}

export default function reportOnlyGate(pi: ExtensionAPI): void {
	// Closure state, not module state: one arming must not leak from the session
	// that researched into a sibling session sharing this process.
	const state = createState();

	pi.on("session_start", () => {
		state.armed = false;
	});

	pi.on("tool_call", (event: ToolCallEvent) => {
		try {
			return decideToolCall(state, event.toolName, event.input);
		} catch {
			return;
		}
	});
}
