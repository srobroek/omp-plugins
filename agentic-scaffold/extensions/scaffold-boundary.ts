import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionToolCallEvent } from "@oh-my-pi/pi-coding-agent";

const EDIT_TOOLS = new Set(["write", "edit", "ast_edit"]);
const SCAFFOLD_COMMAND = "scaffold apply";

type JsonObject = Record<string, unknown>;

function cwdOf(event: ExtensionToolCallEvent): string {
	const value = event.input.cwd;
	return typeof value === "string" && value ? value : process.cwd();
}

function realPathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		try {
			return resolve(realpathSync(dirname(path)), basename(path));
		} catch {
			return resolve(path);
		}
	}
}
export function projectRoot(cwd: string): string {
	return realPathOrResolve(cwd);
}

export function activeScaffoldRoot(cwd: string): string | null {
	const root = projectRoot(cwd);
	const marker = resolve(root, ".omp", "scaffold-run.json");
	if (!existsSync(marker)) return null;
	return root;
}

function inside(root: string, target: string): boolean {
	const suffix = relative(root, target);
	return suffix === "" || (suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix));
}

function pathForRoot(root: string, value: string): string {
	if (value === "~" || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	if (isAbsolute(value)) return realPathOrResolve(value);
	return realPathOrResolve(resolve(root, value));
}

function pathValues(input: JsonObject): string[] {
	const values: string[] = [];
	for (const key of ["path", "file_path", "target"] as const) {
		const value = input[key];
		if (typeof value === "string" && value) values.push(value);
	}
	for (const key of ["paths", "files"] as const) {
		const value = input[key];
		if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string" && item.length > 0));
	}
	return values;
}

function ownedPaths(root: string): Set<string> {
	const owned = new Set<string>();
	for (const statePath of [".omp/scaffold-run.json", ".omp/scaffold-answers.toml", ".omp/scaffold.json", ".omp/plugins.toml", "mise.toml"]) {
		owned.add(pathForRoot(root, statePath));
	}
	const metadataPath = resolve(root, ".omp", "scaffold.json");
	if (!existsSync(metadataPath)) return owned;
	try {
		const parsed: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return owned;
		const meta = parsed as JsonObject;
		const add = (value: unknown): void => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return;
			for (const key of Object.keys(value as JsonObject)) owned.add(pathForRoot(root, key));
		};
		add(meta.owned_hashes);
		const members = meta.members;
		if (Array.isArray(members)) {
			for (const member of members) {
				if (!member || typeof member !== "object" || Array.isArray(member)) continue;
				const memberObject = member as JsonObject;
				const memberRoot = typeof memberObject.dir === "string" ? pathForRoot(root, memberObject.dir) : root;
				const hashes = memberObject.owned_hashes;
				if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) continue;
				for (const key of Object.keys(hashes as JsonObject)) owned.add(pathForRoot(root, relative(root, resolve(memberRoot, key))));
			}
		}
	} catch {
		return owned;
	}
	return owned;
}

export function isScaffoldOwned(root: string, value: string): boolean {
	const target = pathForRoot(root, value);
	return ownedPaths(root).has(target);
}

function pathBlock(root: string, value: string): string | null {
	const target = pathForRoot(root, value);
	if (!inside(root, target)) return `Scaffold run active: use ${SCAFFOLD_COMMAND} for all writes; ${value} is outside the project root.`;
	if (isScaffoldOwned(root, value)) return `Scaffold run active: use ${SCAFFOLD_COMMAND} to update scaffold-owned path ${value}.`;
	return null;
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote = "";
	let escaped = false;
	const push = (): void => {
		if (word) words.push(word);
		word = "";
	};
	for (const char of command) {
		if (escaped) {
			word += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = "";
			else word += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) push();
		else word += char;
	}
	if (word) words.push(word);
	return words;
}

function commandTargetsOutsideRoot(root: string, words: string[]): boolean {
	const isOutside = (value: string): boolean => {
		if (value === "~" || value.startsWith("~/")) return true;
		if (!value.startsWith("/")) return false;
		return !inside(root, pathForRoot(root, value));
	};
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index];
		if (/^>>?$/.test(word) || /^(?:>>?|2>|&>)\S+$/.test(word)) {
			const target = /^>>?$/.test(word) ? words[index + 1] : word.replace(/^(?:>>?|2>|&>)/, "");
			if (target && isOutside(target)) return true;
		}
		if (word !== "tee" && word !== "cp" && word !== "mv") continue;
		const end = words.findIndex((value, offset) => offset > index && ["&&", "||", ";", "|"].includes(value));
		const slice = words.slice(index + 1, end < 0 ? words.length : end).filter((value) => !value.startsWith("-"));
		const targets = word === "tee" ? slice : slice.slice(-1);
		if (targets.some(isOutside)) return true;
	}
	return false;
}

export function deniedBashReason(root: string, command: string): string | null {
	if (/\bchezmoi\s+(?:apply|init|update)\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; chezmoi is not allowed.`;
	if (/\bomp\s+config\s+(?:set|unset)\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; global OMP config is not allowed.`;
	if (/\bomp\s+plugin\s+install\b/.test(command) && !/(?:--scope(?:=|\s+)project)(?:\s|$)/.test(command)) {
		return `Scaffold run active: use ${SCAFFOLD_COMMAND}; project-scope plugin installs are CLI-managed.`;
	}
	if (/\bomp\s+plugin\s+(?:uninstall|marketplace\s+(?:add|remove))\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; plugin removal or marketplace changes are not allowed.`;
	if (/\bgit\s+push\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; git push is not allowed.`;
	if (/\bgit\s+commit\b[^\n;|]*--amend\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; amending commits is not allowed.`;
	if (/\bmise\s+use\b[^\n;|]*(?:-g|--global)\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; global mise changes are not allowed.`;
	const toolsInstall = /\bscaffold\.py\b[^\n;|]*\btools\s+install\b/.test(command);
	if (!toolsInstall && (/(?:^|[;&|])\s*(?:brew|apt)(?:\s|$)/.test(command) || /\bpip\s+install\b/.test(command) || /\bnpm\s+-g(?:lobal)?\b/.test(command) || /\bcargo\s+install\b/.test(command) || /\bgo\s+install\b/.test(command))) {
		return `Scaffold run active: use ${SCAFFOLD_COMMAND}; tool installation is CLI-managed.`;
	}
	if (/\bsudo\b/.test(command)) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; sudo is not allowed.`;
	if (commandTargetsOutsideRoot(root, shellWords(command))) return `Scaffold run active: use ${SCAFFOLD_COMMAND}; writes outside the project root are not allowed.`;
	return null;
}

export type BoundaryDecision = { block: boolean; reason?: string } | undefined;

export function boundaryDecision(event: ExtensionToolCallEvent): BoundaryDecision {
	const cwd = cwdOf(event);
	let root: string | null;
	try {
		root = activeScaffoldRoot(cwd);
	} catch {
		return undefined;
	}
	if (!root) return undefined;
	if (event.toolName === "eval") return { block: true, reason: `Scaffold run active: use ${SCAFFOLD_COMMAND}; inline eval is not allowed.` };
	if (EDIT_TOOLS.has(event.toolName)) {
		for (const value of pathValues(event.input)) {
			const reason = pathBlock(root, value);
			if (reason) return { block: true, reason };
		}
		return undefined;
	}
	if (event.toolName === "bash") {
		const command = event.input.command;
		if (typeof command === "string") {
			const reason = deniedBashReason(root, command);
			if (reason) return { block: true, reason };
		}
	}
	return undefined;
}

export default function scaffoldBoundary(pi: ExtensionAPI): void {
	pi.on("tool_call", (event: ExtensionToolCallEvent) => boundaryDecision(event));
}
