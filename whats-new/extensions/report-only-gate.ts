import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };

/** Dependency manifests. Lowercased basenames; macOS filesystems fold case. */
const MANIFESTS: Record<string, true> = {
	"package.json": true,
	"cargo.toml": true,
	"pyproject.toml": true,
	"go.mod": true,
	"go.sum": true,
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
	"dep_scan/dep_apply confirm loop (reading it releases this gate).";

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
export function targetPaths(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "file_path"] as const) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) out.push(value);
	}
	const { paths } = input;
	if (Array.isArray(paths)) {
		for (const p of paths) {
			if (typeof p === "string" && p.length > 0) out.push(p);
		}
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
	return MANIFESTS[name] === true || LOCKFILE.test(name);
}

export function decideToolCall(
	state: GateState,
	toolName: string,
	input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
	if (toolName === "read") {
		for (const path of targetPaths(input)) {
			if (disarmsGate(path)) state.armed = false;
			else if (armsGate(path)) state.armed = true;
		}
		return;
	}
	if (!state.armed) return;
	if (EDIT_TOOLS[toolName]) {
		if (targetPaths(input).some(isDependencyFile)) return { block: true, reason: DENY_REASON };
		return;
	}
	if (toolName === "bash") {
		const command = input.command;
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

	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			return decideToolCall(state, event.toolName, event.input);
		} catch {
			return;
		}
	});
}
