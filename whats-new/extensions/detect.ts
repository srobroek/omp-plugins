import { parse as parseToml } from "smol-toml";
import { statSync } from "node:fs";

export const MISSING = "?";

const REQ_SPLIT = /[\[<>=!~;\s]/;
const REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;

export type DepRow = [string, string, string];

export function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function join(root: string, name: string): string {
	return root.endsWith("/") ? root + name : `${root}/${name}`;
}

async function readText(path: string): Promise<string | null> {
	try {
		if (!isFile(path)) return null;
		const buf = await Bun.file(path).arrayBuffer();
		let text = new TextDecoder("utf-8").decode(buf);
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		return text;
	} catch {
		return null;
	}
}

function scalar(value: unknown): string {
	if (value === null || value === undefined || typeof value === "object") return MISSING;
	return String(value);
}

function specVersion(spec: unknown): string {
	if (spec && typeof spec === "object" && !Array.isArray(spec)) {
		return scalar((spec as Record<string, unknown>).version);
	}
	if (Array.isArray(spec)) {
		for (const item of spec) {
			if (item && typeof item === "object" && (item as Record<string, unknown>).version != null) {
				return scalar((item as Record<string, unknown>).version);
			}
		}
		return MISSING;
	}
	return scalar(spec);
}

export function parseRequirement(raw: string): [string, string] {
	let line = raw.split("#", 1)[0].trim();
	line = line.replace(/\\+$/, "").trim();
	if (!line || line.startsWith("-") || line.startsWith(".") || line.startsWith("/")) {
		return ["", ""];
	}
	line = line.split(";", 1)[0].trim();
	const match = REQ_SPLIT.exec(line);
	if (!match) {
		return REQ_NAME.test(line) ? [line, MISSING] : ["", ""];
	}
	const name = line.slice(0, match.index).trim();
	if (!REQ_NAME.test(name)) return ["", ""];
	const rest = line.slice(match.index);
	const version = rest.replace(/\[[^\]]*\]/g, "").trim();
	return [name, version || MISSING];
}

export class Detector {
	readonly root: string;
	private readonly map = new Map<string, string>();
	notes: string[] = [];

	constructor(root: string) {
		this.root = root;
	}

	get rows(): DepRow[] {
		const out: DepRow[] = [];
		for (const [key, ver] of this.map) {
			const tab = key.indexOf("\0");
			out.push([key.slice(0, tab), key.slice(tab + 1), ver]);
		}
		return out;
	}

	emit(ecosystem: string, name: string, version: string): void {
		if (name) this.map.set(`${ecosystem}\0${name}`, version || MISSING);
	}

	private note(msg: string): void {
		this.notes.push(msg);
	}

	private async readToml(name: string): Promise<Record<string, unknown> | null> {
		const body = await readText(join(this.root, name));
		if (body === null) return null;
		try {
			const data = parseToml(body);
			return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
		} catch (exc) {
			this.note(`detect: ${name} is unreadable (${exc}); skipping`);
			return null;
		}
	}

	private async readJson(name: string): Promise<Record<string, unknown> | null> {
		const body = await readText(join(this.root, name));
		if (body === null) return null;
		try {
			const data = JSON.parse(body) as unknown;
			return data && typeof data === "object" && !Array.isArray(data)
				? (data as Record<string, unknown>)
				: null;
		} catch (exc) {
			this.note(`detect: ${name} is unreadable (${exc}); skipping`);
			return null;
		}
	}

	private async readLines(name: string): Promise<string[] | null> {
		const body = await readText(join(this.root, name));
		if (body === null) return null;
		return body.split(/\r?\n/);
	}

	async scanNode(): Promise<void> {
		const data = await this.readJson("package.json");
		if (!data) return;
		for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
			const block = data[field];
			if (!block || typeof block !== "object" || Array.isArray(block)) continue;
			for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
				this.emit("npm", name, scalar(spec));
			}
		}
	}

	async scanPython(): Promise<void> {
		for (const lock of ["uv.lock", "poetry.lock"]) {
			const data = await this.readToml(lock);
			if (!data) continue;
			const pkgs = data.package;
			if (Array.isArray(pkgs)) {
				for (const entry of pkgs) {
					if (!entry || typeof entry !== "object") continue;
					const rec = entry as Record<string, unknown>;
					if (typeof rec.name === "string" && typeof rec.version === "string") {
						this.emit("pypi", rec.name, rec.version);
					}
				}
			}
			return;
		}

		const lines = await this.readLines("requirements.txt");
		if (lines) {
			for (const raw of lines) {
				const [name, version] = parseRequirement(raw);
				this.emit("pypi", name, version);
			}
			return;
		}

		const data = await this.readToml("pyproject.toml");
		if (!data) return;
		this.scanPep621(data.project);
		this.scanDependencyGroups(data["dependency-groups"]);
		const tool = data.tool;
		if (tool && typeof tool === "object") {
			this.scanPoetry((tool as Record<string, unknown>).poetry);
		}
	}

	private scanPep621(project: unknown): void {
		if (!project || typeof project !== "object") return;
		const p = project as Record<string, unknown>;
		for (const req of (p.dependencies as unknown[]) || []) {
			if (typeof req === "string") {
				const [name, version] = parseRequirement(req);
				this.emit("pypi", name, version);
			}
		}
		const extras = p["optional-dependencies"];
		if (extras && typeof extras === "object") {
			for (const reqs of Object.values(extras as Record<string, unknown>)) {
				for (const req of (reqs as unknown[]) || []) {
					if (typeof req === "string") {
						const [name, version] = parseRequirement(req);
						this.emit("pypi", name, version);
					}
				}
			}
		}
	}

	private scanDependencyGroups(groups: unknown): void {
		if (!groups || typeof groups !== "object") return;
		for (const reqs of Object.values(groups as Record<string, unknown>)) {
			for (const req of (reqs as unknown[]) || []) {
				if (typeof req === "string") {
					const [name, version] = parseRequirement(req);
					this.emit("pypi", name, version);
				}
			}
		}
	}

	private scanPoetry(poetry: unknown): void {
		if (!poetry || typeof poetry !== "object") return;
		const p = poetry as Record<string, unknown>;
		const blocks: unknown[] = [p.dependencies, p["dev-dependencies"]];
		const groups = p.group;
		if (groups && typeof groups === "object") {
			for (const group of Object.values(groups as Record<string, unknown>)) {
				if (group && typeof group === "object") {
					blocks.push((group as Record<string, unknown>).dependencies);
				}
			}
		}
		for (const block of blocks) {
			if (!block || typeof block !== "object" || Array.isArray(block)) continue;
			for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
				if (name === "python") continue;
				this.emit("pypi", name, specVersion(spec));
			}
		}
	}

	async scanRust(): Promise<void> {
		const data = await this.readToml("Cargo.toml");
		if (!data) return;
		for (const field of ["dependencies", "dev-dependencies", "build-dependencies"]) {
			const block = data[field];
			if (!block || typeof block !== "object" || Array.isArray(block)) continue;
			for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
				this.emit("cargo", name, specVersion(spec));
			}
		}
	}

	async scanGo(): Promise<void> {
		const lines = await this.readLines("go.mod");
		if (!lines) return;
		let inBlock = false;
		for (const raw of lines) {
			const line = raw.trim();
			if (line.startsWith("require (") || line === "require(") {
				inBlock = true;
				continue;
			}
			if (line.startsWith(")")) {
				inBlock = false;
				continue;
			}
			if (line.startsWith("require ")) {
				const fields = line.split(/\s+/);
				this.emit("go", fields[1] ?? "", fields[2] ?? MISSING);
				continue;
			}
			if (inBlock) {
				if (!line || line.startsWith("//")) continue;
				const fields = line.split(/\s+/);
				this.emit("go", fields[0] ?? "", fields[1] ?? MISSING);
			}
		}
	}

	async scanRuby(): Promise<void> {
		const lines = await this.readLines("Gemfile");
		if (!lines) return;
		for (const raw of lines) {
			const match = GEM.exec(raw);
			if (match) this.emit("rubygems", match[2], match[4] || MISSING);
		}
	}

	async scanPhp(): Promise<void> {
		const data = await this.readJson("composer.json");
		if (!data) return;
		for (const field of ["require", "require-dev"]) {
			const block = data[field];
			if (!block || typeof block !== "object" || Array.isArray(block)) continue;
			for (const [rawName, spec] of Object.entries(block as Record<string, unknown>)) {
				const name = String(rawName);
				if (name === "php" || name.startsWith("ext-") || name.startsWith("lib-") || name.includes(" ")) {
					continue;
				}
				this.emit("packagist", name, scalar(spec));
			}
		}
	}

	async scanAll(): Promise<void> {
		await this.scanNode();
		await this.scanPython();
		await this.scanRust();
		await this.scanGo();
		await this.scanRuby();
		await this.scanPhp();
	}
}

export async function detectProject(target: string): Promise<{
	ok: boolean;
	exit: number;
	rows: DepRow[];
	stderr: string;
}> {
	if (!isDir(target)) {
		return { ok: false, exit: 2, rows: [], stderr: `detect: '${target}' is not a directory` };
	}
	const detector = new Detector(target);
	await detector.scanAll();
	const notes = [...detector.notes];
	notes.push("");
	notes.push(`detect: ${detector.rows.length} dependency declaration(s) found in ${target}`);
	if (detector.rows.length === 0) {
		notes.push("No supported manifest found (package.json, uv.lock, poetry.lock,");
		notes.push("requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile,");
		notes.push("composer.json).");
	}
	return { ok: true, exit: 0, rows: detector.rows, stderr: notes.join("\n") };
}
