import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };

/** `.project-setup/answers.toml` or `.../sources.toml`, at any depth. */
const FIXTURE = /(?:^|\/)\.project-setup\/(?:answers|sources)\.toml$/i;

export const DENY_REASON =
	"blocked by dep-update (project-setup owns its answer fixtures): `.project-setup/answers.toml` and " +
	"`.project-setup/sources.toml` record the frozen bootstrap the project-setup runner poured, and that runner " +
	"is their only writer. dep-update reads them for baseline pins and drift notes; it never writes them. " +
	"To move a baseline, re-run project-setup with `--refresh`. To record a bump, apply it with the `dep_apply` " +
	"tool so the real manifest and lockfile change instead.";

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

export function isFixturePath(raw: string): boolean {
	return FIXTURE.test(raw.replaceAll("\\", "/").trim());
}

export function decideToolCall(
	toolName: string,
	input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
	if (!EDIT_TOOLS[toolName]) return;
	if (!targetPaths(input).some(isFixturePath)) return;
	return { block: true, reason: DENY_REASON };
}

export default function fixtureWriteGate(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => {
		try {
			return decideToolCall(event.toolName, event.input);
		} catch {
			return;
		}
	});
}
