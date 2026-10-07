import { statSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

export const MISSING = "?";

const REQ_SPLIT = /[\[<>=!~;\s]/;
export const REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;

/**
 * One dependency. `declared` is the manifest's spec (`?` when the row only exists in a
 * lockfile); `resolved` is the lockfile's installed version, or null when no lockfile
 * pins it. `direct` is false for lockfile entries the project does not declare itself
 * (transitive dependencies), which an upgrade tool must not add as runtime dependencies.
 */
export type DepRow = { ecosystem: string; name: string; declared: string; resolved: string | null; direct: boolean };

/** PEP 503 normalized name: Python package names compare case- and separator-insensitively. */
export function canonical(name: string): string {
	return name.replace(/[-_.]+/g, "-").toLowerCase();
}

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

export async function readText(path: string): Promise<string | null> {
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

/**
 * A lockfile entry built from the local tree: the project itself, a workspace member,
 * or a path dependency. uv records `source = { editable | virtual | directory | path }`;
 * poetry records `[package.source] type = "directory" | "file"` or `develop = true`.
 */
function isLocalLockEntry(rec: Record<string, unknown>): boolean {
	if (rec.develop === true) return true;
	const source = rec.source;
	if (!source || typeof source !== "object" || Array.isArray(source)) return false;
	const s = source as Record<string, unknown>;
	if (s.editable !== undefined || s.virtual !== undefined || s.directory !== undefined || s.path !== undefined) return true;
	return s.type === "directory" || s.type === "file";
}

type Declare = (name: string, spec: string) => void;

export function parseRequirement(raw: string): [string, string] {
	const first = raw.split("#", 1)[0];
	if (first === undefined) return ["", ""];
	let line = first.trim();
	line = line.replace(/\\+$/, "").trim();
	if (!line || line.startsWith("-") || line.startsWith(".") || line.startsWith("/")) {
		return ["", ""];
	}
	const beforeSemicolon = line.split(";", 1)[0];
	if (beforeSemicolon === undefined) return ["", ""];
	line = beforeSemicolon.trim();
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
    private readonly map = new Map<string, { declared: string; resolved: string | null; direct: boolean }>();
	notes: string[] = [];

	constructor(root: string) {
		this.root = root;
	}

    get rows(): DepRow[] {
        const out: DepRow[] = [];
        for (const [key, versions] of this.map) {
            const tab = key.indexOf("\0");
            out.push({ ecosystem: key.slice(0, tab), name: key.slice(tab + 1), ...versions });
        }
        return out;
    }

    emit(ecosystem: string, name: string, declared: string, resolved: string | null = null, direct = true): void {
        if (name) this.map.set(`${ecosystem}\0${name}`, { declared: declared || MISSING, resolved, direct });
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
        const lock = await this.readJson("package-lock.json");
        const locked = new Map<string, string>();
        const packages = lock?.packages;
        if (packages && typeof packages === "object" && !Array.isArray(packages)) {
            for (const [path, entry] of Object.entries(packages as Record<string, unknown>)) {
                if (!path.startsWith("node_modules/") || !entry || typeof entry !== "object") continue;
                const version = (entry as Record<string, unknown>).version;
                if (typeof version === "string") locked.set(path.slice("node_modules/".length), version);
            }
        } else if (lock) {
            this.note("detect: package-lock.json has no packages map; declared Node versions remain unresolved");
        }
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            const block = data[field];
            if (!block || typeof block !== "object" || Array.isArray(block)) continue;
            for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
                this.emit("npm", name, scalar(spec), locked.get(name) ?? null);
            }
        }
    }

	/**
	 * Declarations come from pyproject.toml (PEP 621 dependencies and extras, PEP 735
	 * dependency groups, Poetry tables), else requirements.txt. uv.lock or poetry.lock
	 * only fills `resolved`, matched by normalized name. Lock entries the project does
	 * not declare are emitted as transitive (`direct: false`, declared `?`). Local
	 * sources -- the project itself, workspace members, path dependencies -- are not
	 * registry packages and are skipped.
	 */
	async scanPython(): Promise<void> {
		const declared = new Map<string, [string, string]>();
		const declare: Declare = (name, spec) => {
			if (!name || /^@\s*file:/i.test(spec)) return;
			const key = canonical(name);
			if (!declared.has(key)) declared.set(key, [name, spec]);
		};
		const pyproject = await this.readToml("pyproject.toml");
		if (pyproject) {
			this.scanPep621(pyproject.project, declare);
			this.scanDependencyGroups(pyproject["dependency-groups"], declare);
			const tool = pyproject.tool;
			if (tool && typeof tool === "object") {
				this.scanPoetry((tool as Record<string, unknown>).poetry, declare);
			}
		}
		if (declared.size === 0) {
			for (const raw of (await this.readLines("requirements.txt")) ?? []) {
				const [name, version] = parseRequirement(raw);
				declare(name, version);
			}
		}

		const locked = new Map<string, [string, string]>();
		const local = new Set<string>();
		for (const lock of ["uv.lock", "poetry.lock"]) {
			const data = await this.readToml(lock);
			if (!data) continue;
			const pkgs = data.package;
			if (!Array.isArray(pkgs)) {
				this.note(`detect: ${lock} has no package array; Python versions remain unresolved`);
				continue;
			}
			for (const entry of pkgs) {
				if (!entry || typeof entry !== "object") continue;
				const rec = entry as Record<string, unknown>;
				if (typeof rec.name !== "string" || typeof rec.version !== "string") continue;
				const key = canonical(rec.name);
				if (isLocalLockEntry(rec)) local.add(key);
				else if (!locked.has(key)) locked.set(key, [rec.name, rec.version]);
			}
			break;
		}

		for (const [key, [name, spec]] of declared) {
			if (!local.has(key)) this.emit("pypi", name, spec, locked.get(key)?.[1] ?? null);
		}
		for (const [key, [name, version]] of locked) {
			if (!declared.has(key)) this.emit("pypi", name, MISSING, version, false);
		}
	}

	private scanPep621(project: unknown, declare: Declare): void {
		if (!project || typeof project !== "object") return;
		const p = project as Record<string, unknown>;
		for (const req of Array.isArray(p.dependencies) ? p.dependencies : []) {
			if (typeof req === "string") declare(...parseRequirement(req));
		}
		const extras = p["optional-dependencies"];
		if (extras && typeof extras === "object") {
			for (const reqs of Object.values(extras as Record<string, unknown>)) {
				for (const req of Array.isArray(reqs) ? reqs : []) {
					if (typeof req === "string") declare(...parseRequirement(req));
				}
			}
		}
	}

	private scanDependencyGroups(groups: unknown, declare: Declare): void {
		if (!groups || typeof groups !== "object") return;
		for (const reqs of Object.values(groups as Record<string, unknown>)) {
			for (const req of Array.isArray(reqs) ? reqs : []) {
				if (typeof req === "string") declare(...parseRequirement(req));
			}
		}
	}

	private scanPoetry(poetry: unknown, declare: Declare): void {
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
				// `{ path = "../lib" }` is a local source, not a registry package.
				if (spec && typeof spec === "object" && !Array.isArray(spec) && "path" in spec) continue;
				declare(name, specVersion(spec));
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
			if (match?.[2]) this.emit("rubygems", match[2], match[4] || MISSING);
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

export type ScanCoverage = { gaps: string[] };

export async function detectProject(target: string): Promise<{
    ok: boolean;
    exit: number;
    rows: DepRow[];
    stderr: string;
    coverage: ScanCoverage;
}> {
    if (!isDir(target)) return { ok: false, exit: 2, rows: [], stderr: `detect: '${target}' is not a directory`, coverage: { gaps: [] } };
    const detector = new Detector(target);
    await detector.scanAll();
    const gaps = ["Cargo.lock", "go.sum", "Pipfile.lock", "Ruby/PHP lockfiles", "workspace children"];
    const hasPackageLock = isFile(join(target, "package-lock.json"));
    if (!hasPackageLock) gaps.unshift("Node lockfiles");
    const notes = [...detector.notes];
    notes.push(`Coverage: root declarations; resolved versions from uv.lock/poetry.lock${hasPackageLock ? " and package-lock.json" : ""}; undeclared Python lock entries listed as transitive (direct=false). Unscanned: ${gaps.join(", ")}.`);
    notes.push("");
    notes.push(`detect: ${detector.rows.length} dependency declaration(s) found in ${target}`);
    if (detector.rows.length === 0) {
        notes.push("No supported manifest found (package.json, uv.lock, poetry.lock,");
        notes.push("requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile,");
        notes.push("composer.json).");
    }
    return { ok: true, exit: 0, rows: detector.rows, stderr: notes.join("\n"), coverage: { gaps } };
}
