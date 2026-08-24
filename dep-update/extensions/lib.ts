import { parse as parseToml } from "smol-toml";
import { statSync } from "node:fs";

export const MISSING = "?";
export const USER_AGENT = "dep-update-skill (+https://github.com/srobroek/agentic-packages)";
export const FETCH_TIMEOUT_MS = 10_000;

const REQ_SPLIT = /[\[<>=!~;\s]/;
const REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;
const VERSION_HEAD = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;
const PRERELEASE = /(a|b|rc|alpha|beta|dev|post)[\d.]/i;
const PROTECTED_NAME = /^\.project-setup|answers\.toml|sources\.toml/;

export type DepRow = [string, string, string];

export interface BumpRecord {
	ecosystem: string;
	name: string;
	installed: string;
	latest?: string;
	class?: string;
	status: string;
	reason?: string;
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

export function normalizeVersion(raw: unknown): [number, number, number] | null {
	if (typeof raw !== "string") return null;
	const match = VERSION_HEAD.exec(raw.replace(/^v/, ""));
	if (!match) return null;
	return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

export function isPrerelease(raw: unknown): boolean {
	return typeof raw === "string" && PRERELEASE.test(raw);
}

export function classify(installed: string, latest: string): string {
	const cur = normalizeVersion(installed);
	const lat = normalizeVersion(latest);
	if (cur === null || lat === null) return "MINOR-CHECK";
	if (cur[0] === lat[0] && cur[1] === lat[1] && cur[2] === lat[2]) return "CURRENT";
	if (lat[0] > cur[0]) return "MAJOR-ADVISORY";
	if (lat[0] === cur[0] && lat[1] > cur[1]) return "MINOR-CHECK";
	if (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]) return "PATCH-SAFE";
	return "CURRENT";
}

export function pickStable(latest: string, installed: string, versions: string[]): string {
	if (!isPrerelease(latest) || isPrerelease(installed)) return latest;
	const stable = versions.filter((v) => typeof v === "string" && !isPrerelease(v) && normalizeVersion(v));
	if (!stable.length) return latest;
	stable.sort((a, b) => {
		const na = normalizeVersion(a)!;
		const nb = normalizeVersion(b)!;
		return nb[0] - na[0] || nb[1] - na[1] || nb[2] - na[2];
	});
	return stable[0];
}

export class RegistryError extends Error {
	code?: number;
	constructor(message: string, code?: number) {
		super(message);
		this.code = code;
	}
}

export async function fetchJson(
	ecosystem: string,
	name: string,
	url: string,
	fixtureDir?: string,
): Promise<Record<string, unknown>> {
	const dir = fixtureDir ?? process.env.DEP_UPDATE_FIXTURE_DIR ?? "";
	if (dir) {
		const safe = name.replaceAll("/", "__").replaceAll("@", "__at__");
		const fixture = join(dir, `${ecosystem}_${safe}.json`);
		if (isFile(fixture)) {
			return JSON.parse(await Bun.file(fixture).text()) as Record<string, unknown>;
		}
		throw new RegistryError("fixture not found (offline simulation)");
	}
	const res = await fetch(url, {
		headers: { "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new RegistryError(`HTTP ${res.status}`, res.status);
	return (await res.json()) as Record<string, unknown>;
}

export async function queryRegistry(
	ecosystem: string,
	name: string,
	installed: string,
	fixtureDir?: string,
): Promise<BumpRecord> {
	const result: BumpRecord = { ecosystem, name, installed, status: "UNRESOLVABLE" };
	try {
		let latest = "";
		let candidates: string[] = [];
		if (ecosystem === "pypi") {
			const data = await fetchJson(ecosystem, name, `https://pypi.org/pypi/${name}/json`, fixtureDir);
			const info = data.info as Record<string, unknown> | undefined;
			const ver = info?.version;
			if (typeof ver !== "string" || !ver) {
				result.reason = "no info.version";
				return result;
			}
			latest = ver;
			const releases = (data.releases ?? {}) as Record<string, unknown>;
			const files = (releases[latest] as Array<Record<string, unknown>>) || [];
			if (files.length && files.every((f) => f.yanked)) {
				result.status = "DISCONFIRMED";
				result.latest = latest;
				result.reason = "all files for latest are yanked on PyPI";
				result.class = "DISCONFIRMED";
				return result;
			}
			candidates = Object.keys(releases);
		} else if (ecosystem === "npm" || ecosystem === "node") {
			const data = await fetchJson(ecosystem, name, `https://registry.npmjs.org/${name}`, fixtureDir);
			const tags = (data["dist-tags"] ?? {}) as Record<string, unknown>;
			const ver = tags.latest;
			if (typeof ver !== "string" || !ver) {
				result.reason = "no dist-tags.latest";
				return result;
			}
			latest = ver;
			candidates = Object.keys((data.versions ?? {}) as Record<string, unknown>);
		} else {
			result.reason = `registry fetch not implemented for ${ecosystem} (advisory-only)`;
			return result;
		}
		latest = pickStable(latest, installed, candidates);
		const verdict = classify(installed, latest);
		result.latest = latest;
		result.status = verdict === "CURRENT" ? "CURRENT" : "OK";
		result.class = verdict;
		return result;
	} catch (exc) {
		if (exc instanceof RegistryError && exc.code !== undefined) {
			result.reason = exc.code === 401 || exc.code === 403 ? "auth-required" : `HTTP ${exc.code}`;
			return result;
		}
		if (exc instanceof RegistryError) {
			result.reason = `network error: ${exc.message}`;
			return result;
		}
		result.reason = exc instanceof Error ? exc.message : String(exc);
		return result;
	}
}

export async function researchProject(
	target: string,
	fixtureDir?: string,
): Promise<{ exit: number; records: BumpRecord[]; stderr: string }> {
	if (!isDir(target)) {
		return { exit: 2, records: [], stderr: `research: '${target}' is not a directory` };
	}
	const notes: string[] = ["dep-update/research: querying registries...", ""];
	const detected = await detectProject(target);
	const tallies = { OK: 0, CURRENT: 0, UNRESOLVABLE: 0, DISCONFIRMED: 0 };
	const records: BumpRecord[] = [];
	for (const [ecosystem, name, installed] of detected.rows) {
		if (!ecosystem || !name) continue;
		const record = await queryRegistry(ecosystem, name, installed, fixtureDir);
		records.push(record);
		const status = record.status;
		if (status in tallies) tallies[status as keyof typeof tallies] += 1;
	}
	const unresolvable = tallies.UNRESOLVABLE + tallies.DISCONFIRMED;
	notes.push("");
	notes.push(`dep-update/research: ${records.length} dep(s) queried`);
	notes.push(`  classified:    ${tallies.OK}`);
	notes.push(`  already-current: ${tallies.CURRENT}`);
	notes.push(`  unresolvable:  ${unresolvable}`);
	if (records.length > 0 && tallies.OK === 0 && tallies.CURRENT === 0 && unresolvable === records.length) {
		notes.push("");
		notes.push("WARNING: all registry queries failed - no registry access or all deps are private.");
		notes.push("No upgrade plan can be produced. Check your network connection and retry.");
	}
	return { exit: 0, records, stderr: notes.join("\n") };
}

export function canonical(name: string): string {
	return name.replace(/[-_.]+/g, "-").toLowerCase();
}

export function which(bin: string): string | null {
	const path = process.env.PATH ?? "";
	for (const dir of path.split(":")) {
		const cand = `${dir}/${bin}`;
		try {
			if (statSync(cand).isFile()) return cand;
		} catch {
			/* skip */
		}
	}
	return null;
}

async function readTomlFile(path: string): Promise<Record<string, unknown> | null> {
	const body = await readText(path);
	if (body === null) return null;
	try {
		return parseToml(body) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function detectNodePm(root: string): Promise<string> {
	const override = process.env.DEP_UPDATE_PKG_MANAGER ?? "";
	if (override) return override;
	const answers = join(root, ".project-setup/answers.toml");
	if (isFile(answers)) {
		try {
			const data = await readTomlFile(answers);
			const module = (data?.module ?? {}) as Record<string, unknown>;
			const langTs = (module["lang-ts"] ?? {}) as Record<string, unknown>;
			const pinned = langTs.package_manager || langTs.package_manager_pin || "";
			if (pinned) return String(pinned).split("@")[0].trim();
		} catch {
			/* fail open */
		}
	}
	if (isFile(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (isFile(join(root, "bun.lock")) || isFile(join(root, "bun.lockb"))) return "bun";
	if (isFile(join(root, "yarn.lock"))) return "yarn";
	return "npm";
}

function splitPin(requirement: string): [string, string] {
	const body = requirement.split(";", 1)[0].trim();
	if (!body.includes("==")) return ["", ""];
	const idx = body.indexOf("==");
	const name = body.slice(0, idx).replace(/\[[^\]]*\]/g, "").trim();
	return [name, body.slice(idx + 2).trim()];
}

function pyprojectRequirements(data: Record<string, unknown>): string[] {
	const out: string[] = [];
	const project = data.project;
	if (project && typeof project === "object") {
		const p = project as Record<string, unknown>;
		for (const r of (p.dependencies as unknown[]) || []) if (typeof r === "string") out.push(r);
		const extras = p["optional-dependencies"];
		if (extras && typeof extras === "object") {
			for (const reqs of Object.values(extras as Record<string, unknown>)) {
				for (const r of (reqs as unknown[]) || []) if (typeof r === "string") out.push(r);
			}
		}
	}
	const groups = data["dependency-groups"];
	if (groups && typeof groups === "object") {
		for (const reqs of Object.values(groups as Record<string, unknown>)) {
			for (const r of (reqs as unknown[]) || []) if (typeof r === "string") out.push(r);
		}
	}
	return out;
}

export async function checkPythonVersion(root: string, name: string, version: string): Promise<boolean> {
	const wanted = canonical(name);
	const pyproject = join(root, "pyproject.toml");
	if (isFile(pyproject)) {
		const data = await readTomlFile(pyproject);
		if (data) {
			for (const requirement of pyprojectRequirements(data)) {
				const [reqName, reqVersion] = splitPin(requirement);
				if (reqName && canonical(reqName) === wanted && reqVersion === version) return true;
			}
		}
	}
	const requirements = join(root, "requirements.txt");
	if (isFile(requirements)) {
		const text = (await readText(requirements)) ?? "";
		for (const raw of text.split(/\r?\n/)) {
			const [reqName, reqVersion] = splitPin(raw.split("#", 1)[0].trim());
			if (reqName && canonical(reqName) === wanted && reqVersion === version) return true;
		}
	}
	const lock = join(root, "uv.lock");
	if (isFile(lock)) {
		const data = await readTomlFile(lock);
		if (!data) return false;
		for (const entry of (data.package as unknown[]) || []) {
			if (!entry || typeof entry !== "object") continue;
			const rec = entry as Record<string, unknown>;
			if (canonical(String(rec.name ?? "")) === wanted) return rec.version === version;
		}
		return false;
	}
	return false;
}

export async function checkNodeVersion(root: string, name: string, version: string): Promise<boolean> {
	const manifest = join(root, "package.json");
	if (!isFile(manifest)) return false;
	try {
		const data = JSON.parse((await readText(manifest)) ?? "") as unknown;
		if (!data || typeof data !== "object") return false;
		const rec = data as Record<string, unknown>;
		const accepted = new Set([version, `^${version}`, `~${version}`, `=${version}`]);
		for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
			const block = rec[section];
			if (!block || typeof block !== "object") continue;
			const declared = (block as Record<string, unknown>)[name];
			if (typeof declared === "string" && accepted.has(declared)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

async function runPm(command: string[], root: string): Promise<{ code: number; log: string }> {
	const log = `==> ${command.join(" ")}`;
	const proc = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { code, log: [log, stdout, stderr].filter(Boolean).join("\n") };
}

export async function applyBump(
	ecosystem: string,
	name: string,
	version: string,
	root: string,
): Promise<{ exit: number; text: string }> {
	if (!isDir(root)) {
		return { exit: 2, text: `ERROR: '${root}' is not a directory` };
	}
	if (PROTECTED_NAME.test(name)) {
		return { exit: 2, text: "ERROR: refusing to touch project-setup files" };
	}
	const lines = [`dep-update/apply: ${ecosystem} ${name} -> ${version}`];

	if (ecosystem === "pypi" || ecosystem === "python") {
		if (!which("uv")) {
			lines.push("SKIP: uv not found. To apply manually:");
			lines.push(`  uv add "${name}==${version}"`);
			lines.push(`  (or: pip install "${name}==${version}" and update your requirements file)`);
			return { exit: 0, text: lines.join("\n") };
		}
		const ran = await runPm(["uv", "add", `${name}==${version}`], root);
		lines.push(ran.log);
		if (ran.code !== 0) {
			lines.push(`WARN: uv exited with status ${ran.code}; bump was not confirmed`);
			return { exit: 1, text: lines.join("\n") };
		}
		const landed = await checkPythonVersion(root, name, version);
		if (landed) {
			lines.push(`OK: ${name} confirmed at ${version}`);
			return { exit: 0, text: lines.join("\n") };
		}
		lines.push(`WARN: ${name}: post-apply manifest check failed - version may not have landed`);
		return { exit: 1, text: lines.join("\n") };
	}

	if (["npm", "node", "pnpm", "yarn", "bun"].includes(ecosystem)) {
		let pm = await detectNodePm(root);
		const cmds: Record<string, string[]> = {
			pnpm: ["pnpm", "update", name, "--version", version],
			bun: ["bun", "add", `${name}@${version}`],
			yarn: ["yarn", "add", `${name}@${version}`],
			npm: ["npm", "install", `${name}@${version}`],
		};
		if (!(pm in cmds)) pm = "npm";
		const command = cmds[pm];
		if (!which(pm)) {
			lines.push(`SKIP: ${pm} not found. To apply manually:`);
			lines.push(`  ${command.join(" ")}`);
			return { exit: 0, text: lines.join("\n") };
		}
		const ran = await runPm(command, root);
		lines.push(ran.log);
		if (ran.code !== 0) {
			lines.push(`WARN: ${pm} exited with status ${ran.code}; bump was not confirmed`);
			return { exit: 1, text: lines.join("\n") };
		}
		const landed = await checkNodeVersion(root, name, version);
		if (landed) {
			lines.push(`OK: ${name} confirmed at ${version}`);
			return { exit: 0, text: lines.join("\n") };
		}
		lines.push(`WARN: ${name}: post-apply manifest check failed - version may not have landed`);
		return { exit: 1, text: lines.join("\n") };
	}

	if (ecosystem === "cargo" || ecosystem === "rust") {
		lines.push("ADVISORY-ONLY: Rust deps are advisory-only in this version.");
		lines.push(`To update manually: cargo update -p ${name} --precise ${version}`);
		return { exit: 0, text: lines.join("\n") };
	}
	if (ecosystem === "go") {
		lines.push("ADVISORY-ONLY: Go deps are advisory-only in this version.");
		lines.push(`To update manually: go get ${name}@${version} && go mod tidy`);
		return { exit: 0, text: lines.join("\n") };
	}
	lines.push(`WARN: unknown ecosystem '${ecosystem}'`);
	lines.push(`Cannot apply automatically. Check the registry for ${name}@${version}.`);
	return { exit: 0, text: lines.join("\n") };
}
