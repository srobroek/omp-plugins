import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

// The detection half of this file lives in ./detect.ts, which is byte-identical to
// whats-new/extensions/detect.ts. Both plugins bundle in isolation, so the file is
// duplicated rather than shared, and scripts/check-shared-detector.py fails CI when
// the two copies drift. Re-exported wholesale so this module's public surface is
// unchanged for its consumers.
export * from "./detect";

import { canonical, detectProject, isDir, isFile, REQ_NAME, readText } from "./detect";

export const USER_AGENT = "dep-update-skill (+https://github.com/srobroek/omp-plugins)";
export const FETCH_TIMEOUT_MS = 10_000;
/**
 * Aggregate bound for one scan. A registered tool's execute runs under no harness
 * deadline, so this only stops a degraded registry: fetches run one after another,
 * and 30 of them hitting FETCH_TIMEOUT_MS fill it. The caller's abort signal stops
 * a scan sooner. Either way the dependencies not yet queried are reported UNCHECKED.
 */
export const SCAN_TIMEOUT_MS = 300_000;

class ScanDeadlineError extends Error {
    constructor() { super("dependency scan aggregate deadline exceeded"); }
}
class RegistryError extends Error {
    constructor(message: string, readonly code?: number) {
        super(message);
    }
}

function ensureDeadline(deadline?: number): void {
    if (deadline !== undefined && Date.now() >= deadline) throw new ScanDeadlineError();
}

const NODE_VERSION = /^=?v?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<pre>(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PYTHON_VERSION = /^(?:={1,2})?v?(?<major>\d+)(?:\.(?<minor>\d+))?(?:\.(?<patch>\d+))?(?:[-_.]?(?<phase>a|b|rc|alpha|beta|pre|preview)[-_.]?(?<phaseNumber>\d*))?(?:[-_.]?(?<post>post)[-_.]?(?<postNumber>\d*))?(?:[-_.]?(?<dev>dev)[-_.]?(?<devNumber>\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;
/** PEP 440 pre-release phases in order; `pre`/`preview` spell `rc`. */
const PYTHON_PRE_RANK: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, rc: 2, pre: 2, preview: 2 };

export interface BumpRecord {
	ecosystem: string;
	name: string;
	installed: string;
	latest?: string;
	class?: string;
	status: string;
	reason?: string;
}

/** An exact version's suffix by name: Node's prerelease, or Python's PEP 440 phase, post and dev parts. */
export type VersionParts = {
	pre?: string;
	phase?: string;
	phaseNumber?: string;
	post?: string;
	postNumber?: string;
	dev?: string;
	devNumber?: string;
};

export type ParsedVersion = { release: [number, number, number]; parts: VersionParts };

/** The release triple and suffix of an exact version, or null when `raw` is not one. */
export function parseVersion(raw: unknown, ecosystem = "npm"): ParsedVersion | null {
	if (typeof raw !== "string") return null;
	const groups = (ecosystem === "pypi" ? PYTHON_VERSION : NODE_VERSION).exec(raw)?.groups;
	if (groups === undefined) return null;
	const { major, minor, patch, ...parts } = groups;
	const release: [number, number, number] = [Number(major), Number(minor || 0), Number(patch || 0)];
	return release.every(Number.isSafeInteger) ? { release, parts } : null;
}

export function normalizeVersion(raw: unknown, ecosystem = "npm"): [number, number, number] | null {
	return parseVersion(raw, ecosystem)?.release ?? null;
}

export function isPrerelease(raw: unknown, ecosystem = "npm"): boolean {
	const parts = parseVersion(raw, ecosystem)?.parts;
	if (parts === undefined) return false;
	return Boolean(ecosystem === "pypi" ? parts.phase || parts.dev : parts.pre);
}

/**
 * Order two versions that share a release triple by their suffixes. Python follows
 * PEP 440 (`.devN` < `aN` < `bN` < `rcN` < final < `.postN`, a `.dev` of any phase
 * sorting just below it); Node follows SemVer 2 precedence (a prerelease sorts below
 * the release; identifiers compare numerically, then lexically, then by count).
 */
function compareSuffix(a: VersionParts, b: VersionParts, ecosystem: string): number {
	if (ecosystem === "pypi") {
		const key = (v: VersionParts): number[] => {
			const pre = v.phase ? [PYTHON_PRE_RANK[v.phase.toLowerCase()] ?? 2, Number(v.phaseNumber || 0)] : [v.dev && !v.post ? -1 : 3, 0];
			return [...pre, v.post ? Number(v.postNumber || 0) : -1, v.dev ? Number(v.devNumber || 0) : Number.POSITIVE_INFINITY];
		};
		const ka = key(a);
		const kb = key(b);
		for (let i = 0; i < ka.length; i++) {
			const x = ka[i] as number;
			const y = kb[i] as number;
			if (x !== y) return x < y ? -1 : 1;
		}
		return 0;
	}
	const pa = a.pre?.split(".") ?? [];
	const pb = b.pre?.split(".") ?? [];
	if (pa.length === 0 && pb.length === 0) return 0;
	if (pa.length === 0) return 1;
	if (pb.length === 0) return -1;
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		const x = pa[i] as string;
		const y = pb[i] as string;
		if (x === y) continue;
		const nx = /^\d+$/.test(x);
		const ny = /^\d+$/.test(y);
		if (nx && ny) return Math.sign(Number(x) - Number(y));
		if (nx !== ny) return nx ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return Math.sign(pa.length - pb.length);
}

/** Full precedence of two exact versions, or null when either is not an exact version. */
export function compareVersions(a: string, b: string, ecosystem = "npm"): number | null {
	const pa = parseVersion(a, ecosystem);
	const pb = parseVersion(b, ecosystem);
	if (pa === null || pb === null) return null;
	const [na, nb] = [pa.release, pb.release];
	const triple = Math.sign(na[0] - nb[0] || na[1] - nb[1] || na[2] - nb[2]);
	if (triple !== 0) return triple;
	return compareSuffix(pa.parts, pb.parts, ecosystem);
}

export function classify(installed: string, latest: string, ecosystem = "npm"): string {
	const cur = normalizeVersion(installed, ecosystem);
	const lat = normalizeVersion(latest, ecosystem);
	if (cur === null || lat === null) return "UNRESOLVABLE";
	if (lat[0] > cur[0]) return "MAJOR-ADVISORY";
	if (lat[0] === cur[0] && lat[1] > cur[1]) return "MINOR-CHECK";
	if (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]) return "PATCH-SAFE";
	// Same release triple: 1.0.0-rc.1 -> 1.0.0 and 1.0.0 -> 1.0.0.post1 are real upgrades.
	if (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] === cur[2] && (compareVersions(latest, installed, ecosystem) ?? 0) > 0) {
		return "PATCH-SAFE";
	}
	return "CURRENT";
}

export function pickStable(latest: string, installed: string, versions: string[], ecosystem = "npm"): string {
	if (!isPrerelease(latest, ecosystem) || isPrerelease(installed, ecosystem)) return latest;
	const stable = versions.filter((v) => !isPrerelease(v, ecosystem) && normalizeVersion(v, ecosystem));
	if (!stable.length) return latest;
	stable.sort((a, b) => compareVersions(b, a, ecosystem) ?? 0);
    return stable[0] ?? latest;
}
export async function fetchJson(
    ecosystem: string,
    name: string,
    url: string,
    fixtureDir?: string,
    signal?: AbortSignal,
    deadline?: number,
): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    ensureDeadline(deadline);
    const dir = fixtureDir ?? process.env.DEP_UPDATE_FIXTURE_DIR ?? "";
    if (dir) {
        const safe = name.replaceAll("/", "__").replaceAll("@", "__at__");
        const fixture = join(dir, `${ecosystem}_${safe}.json`);
        if (isFile(fixture)) {
            const data = JSON.parse(await Bun.file(fixture).text()) as Record<string, unknown>;
            signal?.throwIfAborted();
            ensureDeadline(deadline);
            return data;
        }
        throw new RegistryError("fixture not found (offline simulation)");
    }
    const remaining = deadline === undefined ? FETCH_TIMEOUT_MS : deadline - Date.now();
    if (remaining <= 0) throw new ScanDeadlineError();
    const requestDeadline = AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining));
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: signal ? AbortSignal.any([signal, requestDeadline]) : requestDeadline });
    ensureDeadline(deadline);
    if (!res.ok) throw new RegistryError(`HTTP ${res.status}`, res.status);
    const data = (await res.json()) as Record<string, unknown>;
    signal?.throwIfAborted();
    ensureDeadline(deadline);
    return data;
}

export async function queryRegistry(
    ecosystem: string,
    name: string,
    installed: string,
    fixtureDir?: string,
    signal?: AbortSignal,
    deadline?: number,
): Promise<BumpRecord> {
    signal?.throwIfAborted();
    ensureDeadline(deadline);
    const result: BumpRecord = { ecosystem, name, installed, status: "UNRESOLVABLE" };
    try {
        let latest = "";
        let candidates: string[] = [];
        if (ecosystem === "pypi") {
            const data = await fetchJson(ecosystem, name, `https://pypi.org/pypi/${name}/json`, fixtureDir, signal, deadline);
            const info = data.info as Record<string, unknown> | undefined;
            const ver = info?.version;
            if (typeof ver !== "string" || !ver) { result.reason = "no info.version"; return result; }
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
            const data = await fetchJson(ecosystem, name, `https://registry.npmjs.org/${name}`, fixtureDir, signal, deadline);
            const tags = (data["dist-tags"] ?? {}) as Record<string, unknown>;
            const ver = tags.latest;
            if (typeof ver !== "string" || !ver) { result.reason = "no dist-tags.latest"; return result; }
            latest = ver;
            candidates = Object.keys((data.versions ?? {}) as Record<string, unknown>);
        } else {
            result.reason = `registry fetch not implemented for ${ecosystem} (advisory-only)`;
            return result;
        }
        ensureDeadline(deadline);
        latest = pickStable(latest, installed, candidates, ecosystem);
        const verdict = classify(installed, latest, ecosystem);
        result.latest = latest;
        result.status = verdict === "CURRENT" || verdict === "UNRESOLVABLE" ? verdict : "OK";
        if (verdict === "UNRESOLVABLE") result.reason = "Exact versions are required to classify an upgrade; resolve the declaration before applying.";
        result.class = verdict;
        return result;
    } catch (exc) {
        if (exc instanceof ScanDeadlineError) throw exc;
        signal?.throwIfAborted();
        // A fetch the aggregate deadline cut short says nothing about the registry.
        ensureDeadline(deadline);
        if (exc instanceof RegistryError && exc.code !== undefined) {
            result.reason = exc.code === 401 || exc.code === 403 ? "auth-required" : `HTTP ${exc.code}`;
            return result;
        }
        if (exc instanceof RegistryError) { result.reason = `network error: ${exc.message}`; return result; }
        result.reason = exc instanceof Error ? exc.message : String(exc);
        return result;
    }
}

export async function researchProject(
    target: string,
    fixtureDir?: string,
    signal?: AbortSignal,
    timeoutMs = SCAN_TIMEOUT_MS,
): Promise<{ exit: number; records: BumpRecord[]; stderr: string; complete: boolean }> {
    const deadline = Date.now() + timeoutMs;
    /** Why the scan must stop before the next query, or undefined while it may continue. */
    const stopReason = () => (signal?.aborted ? "cancelled" : Date.now() >= deadline ? "scan deadline reached" : undefined);
    if (signal?.aborted) return { exit: 0, records: [], stderr: "dep-update/research: PARTIAL: cancelled before any dependency was read.", complete: false };
    if (!isDir(target)) return { exit: 2, records: [], stderr: `research: '${target}' is not a directory`, complete: true };
    const notes: string[] = ["dep-update/research: querying registries...", ""];
    const detected = await detectProject(target);
    notes.push(detected.stderr);
    const tallies = { OK: 0, CURRENT: 0, UNRESOLVABLE: 0, DISCONFIRMED: 0, UNCHECKED: 0 };
    const records: BumpRecord[] = [];
    let stopped: string | undefined;
    // Transitive lock entries are not the project's to bump: applying one would add it
    // as a new direct dependency. Only declared rows are researched.
    const direct = detected.rows.filter((row) => row.direct);
    const transitive = detected.rows.length - direct.length;
    for (const { ecosystem, name, declared, resolved } of direct) {
        if (!ecosystem || !name) continue;
        const installed = resolved ?? declared;
        stopped ??= stopReason();
        let record: BumpRecord | undefined;
        if (!stopped) {
            try {
                record = await queryRegistry(ecosystem, name, installed, fixtureDir, signal, deadline);
            } catch (exc) {
                // Only a cancellation or the aggregate deadline escapes queryRegistry.
                stopped = stopReason();
                if (!stopped) throw exc;
            }
        }
        record ??= { ecosystem, name, installed, status: "UNCHECKED", reason: `not checked: ${stopped}` };
        records.push(record);
        if (record.status in tallies) tallies[record.status as keyof typeof tallies] += 1;
    }
    const queried = records.length - tallies.UNCHECKED;
    notes.push("");
    notes.push(`dep-update/research: ${queried} dep(s) queried`);
    notes.push(`  classified:    ${tallies.OK}`);
    notes.push(`  already-current: ${tallies.CURRENT}`);
    notes.push(`  unresolvable:  ${tallies.UNRESOLVABLE + tallies.DISCONFIRMED}`);
    if (transitive > 0) notes.push(`  transitive (not queried): ${transitive}`);
    if (stopped) notes.push(`PARTIAL: ${stopped}; ${tallies.UNCHECKED} dependenc${tallies.UNCHECKED === 1 ? "y was" : "ies were"} not checked.`);
    if (queried > 0 && tallies.OK === 0 && tallies.CURRENT === 0 && tallies.UNRESOLVABLE + tallies.DISCONFIRMED === queried) {
        notes.push("");
        notes.push("WARNING: no dependency versions could be classified.");
        notes.push("Resolve declared ranges and inspect each record's reason before planning upgrades.");
    }
    return { exit: 0, records, stderr: notes.join("\n"), complete: stopped === undefined };
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

export function detectNodePm(root: string): string {
	const override = process.env.DEP_UPDATE_PKG_MANAGER ?? "";
	if (override) return override;
	if (isFile(join(root, "pnpm-lock.yaml"))) return "pnpm";
	if (isFile(join(root, "bun.lock")) || isFile(join(root, "bun.lockb"))) return "bun";
	if (isFile(join(root, "yarn.lock"))) return "yarn";
	return "npm";
}

function splitPin(requirement: string): [string, string] {
	// Poetry 2 writes PEP 621 pins as `name (==1.2.3)`.
	const body = (requirement.split(";", 1)[0] ?? "").replace(/[()]/g, "").trim();
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
		for (const r of Array.isArray(p.dependencies) ? p.dependencies : []) if (typeof r === "string") out.push(r);
		const extras = p["optional-dependencies"];
		if (extras && typeof extras === "object") {
			for (const reqs of Object.values(extras as Record<string, unknown>)) {
				for (const r of Array.isArray(reqs) ? reqs : []) if (typeof r === "string") out.push(r);
			}
		}
	}
	const groups = data["dependency-groups"];
	if (groups && typeof groups === "object") {
		for (const reqs of Object.values(groups as Record<string, unknown>)) {
			for (const r of Array.isArray(reqs) ? reqs : []) if (typeof r === "string") out.push(r);
		}
	}
	// Poetry tables pin as `name = "1.2.3"` (or `"==1.2.3"`, or `{ version = ... }`).
	const tool = data.tool;
	const poetry = tool && typeof tool === "object" ? (tool as Record<string, unknown>).poetry : undefined;
	if (poetry && typeof poetry === "object") {
		const p = poetry as Record<string, unknown>;
		const blocks: unknown[] = [p.dependencies, p["dev-dependencies"]];
		if (p.group && typeof p.group === "object") {
			for (const group of Object.values(p.group as Record<string, unknown>)) {
				if (group && typeof group === "object") blocks.push((group as Record<string, unknown>).dependencies);
			}
		}
		for (const block of blocks) {
			if (!block || typeof block !== "object" || Array.isArray(block)) continue;
			for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
				const raw = spec && typeof spec === "object" ? (spec as Record<string, unknown>).version : spec;
				if (typeof raw === "string") out.push(`${name}==${raw.replace(/^==/, "")}`);
			}
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
			const [reqName, reqVersion] = splitPin((raw.split("#", 1)[0] ?? "").trim());
			if (reqName && canonical(reqName) === wanted && reqVersion === version) return true;
		}
	}
	const lock = join(root, "uv.lock");
	if (isFile(lock)) {
		const data = await readTomlFile(lock);
		if (!data) return false;
		for (const entry of Array.isArray(data.package) ? data.package : []) {
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
			if (!block || typeof block !== "object" || Array.isArray(block) || !Object.hasOwn(block, name)) continue;
			const declared = (block as Record<string, unknown>)[name];
			if (typeof declared === "string" && accepted.has(declared)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Bound for one package-manager run. A registered tool's execute runs under no harness
 * deadline; a real install that resolves a lockfile and builds native modules can take
 * minutes, so this only stops a hung manager. The caller's abort signal stops it sooner.
 */
const APPLY_TIMEOUT_MS = 600_000;

type ApplyOptions = {
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutputBytes?: number;
    setTimeout?: (callback: () => void, ms: number) => Timer;
    clearTimer?: (timer: Timer) => void;
};

async function runPm(command: string[], root: string, options: ApplyOptions): Promise<{ code: number; log: string }> {
	if (options.signal?.aborted) return { code: 1, log: "Cancelled before spawn; no changes made." };
	const schedule = options.setTimeout ?? setTimeout;
	const clear = options.clearTimer ?? clearTimeout;
	return new Promise((resolve) => {
		const executable = command[0];
		if (!executable) { resolve({ code: 1, log: "No package manager command provided" }); return; }
		const proc = spawn(executable, command.slice(1), {
			cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
		});
		const chunks: Buffer[] = [];
		const limit = Math.max(1, Math.min(options.maxOutputBytes ?? 65_536, 65_536));
		let bytes = 0;
		let stopped = "";
		let settled = false;
		let cleanup: Timer | undefined;
		const kill = () => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
				else proc.kill("SIGKILL");
			} catch { /* already exited */ }
		};
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clear(deadline);
			if (cleanup) clear(cleanup);
			options.signal?.removeEventListener("abort", abort);
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			resolve({
				code, log: [`==> ${command.join(" ")}`, Buffer.concat(chunks).toString("utf8"),
				stopped && `${stopped}; partial dependency changes may remain. Inspect manifests and lockfiles before retrying.`,
				].filter(Boolean).join("\n")
			});
		};
		const stop = (reason: string) => {
			if (stopped || settled) return;
			stopped = reason;
			kill();
			cleanup = schedule(() => finish(1), 1_000);
		};
        const abort = () => stop("Cancelled");
        const deadline = schedule(
            () => stop("Package manager deadline exceeded; partial dependency changes may remain and were reported"),
            Math.max(1, options.timeoutMs ?? APPLY_TIMEOUT_MS),
        );
		const collect = (chunk: Buffer) => {
			const remaining = limit - bytes;
			if (remaining > 0) {
				const kept = chunk.subarray(0, remaining);
				chunks.push(Buffer.from(kept));
				bytes += kept.length;
			}
			if (chunk.length > remaining) stop("Package manager output limit exceeded");
		};
		proc.stdout.on("data", collect);
		proc.stderr.on("data", collect);
		proc.on("error", () => { stopped = "Package manager failed to start"; finish(1); });
		proc.on("close", (code) => finish(stopped ? 1 : (code ?? 1)));
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
	});
}

function validOperands(ecosystem: string, name: string, version: string): boolean {
	const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
	if (["npm", "node", "pnpm", "yarn", "bun"].includes(ecosystem)) {
		return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214 && semver.test(version);
	}
	if (ecosystem === "pypi" || ecosystem === "python") {
		return REQ_NAME.test(name) && /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i.test(version);
	}
	if (ecosystem === "cargo" || ecosystem === "rust") return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) && semver.test(version);
	if (ecosystem === "go") return /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(name) && semver.test(version.replace(/^v/, ""));
	return false;
}

/**
 * Run one package-manager bump in `root`, then confirm the pin reached the manifest.
 * Every ecosystem that applies a bump ends here, so the three outcomes a caller reads
 * (a failed run, an unconfirmed pin, a confirmed pin) are worded once.
 */
async function runAndConfirm(
	lines: string[],
	command: string[],
	bump: { root: string; name: string; version: string; options: ApplyOptions },
	confirm: () => Promise<boolean>,
): Promise<{ exit: number; text: string }> {
	const pm = command[0] as string;
	if (!which(pm)) {
		lines.push(`ERROR: ${pm} not found; cannot apply dependency bump`);
		lines.push(`  ${command.join(" ")}`);
		return { exit: 1, text: lines.join("\n") };
	}
	const ran = await runPm(command, bump.root, bump.options);
	lines.push(ran.log);
	if (ran.code !== 0) {
		lines.push(`WARN: ${pm} exited with status ${ran.code}; partial changes may remain; bump was not confirmed`);
		return { exit: 1, text: lines.join("\n") };
	}
	if (await confirm()) {
		lines.push(`OK: ${bump.name} confirmed at ${bump.version}`);
		return { exit: 0, text: lines.join("\n") };
	}
	lines.push(`WARN: ${bump.name}: post-apply manifest check failed - version may not have landed`);
	return { exit: 1, text: lines.join("\n") };
}

export async function applyBump(
	ecosystem: string,
	name: string,
	version: string,
	root: string,
	options: ApplyOptions = {},
): Promise<{ exit: number; text: string }> {
	if (!validOperands(ecosystem, name, version)) return { exit: 2, text: "ERROR: unsupported ecosystem, package name, or exact version; no process started" };
	if (options.signal?.aborted) return { exit: 1, text: "Cancelled before spawn; no changes made." };
	if (!isDir(root)) {
		return { exit: 2, text: `ERROR: '${root}' is not a directory` };
	}
	const lines = [`dep-update/apply: ${ecosystem} ${name} -> ${version}`];
	const bump = { root, name, version, options };

	if (ecosystem === "pypi" || ecosystem === "python") {
		const pyprojectPath = join(root, "pyproject.toml");
		if (!isFile(pyprojectPath)) {
			// requirements.txt (or no manifest at all): no manager owns the file, and
			// installing into whatever environment is active would not record the pin.
			lines.push("MANUAL: no pyproject.toml; dep_apply does not edit requirements files.");
			lines.push(`To update manually: set ${name}==${version} in the requirements file, then reinstall it in the project's environment.`);
			return { exit: 0, text: lines.join("\n") };
		}
		const pyproject = await readTomlFile(pyprojectPath);
		const tool = pyproject?.tool;
		const poetry = isFile(join(root, "poetry.lock")) || Boolean(tool && typeof tool === "object" && "poetry" in tool);
		// Without uv.lock, `--frozen` edits pyproject.toml without creating a lockfile the project never had.
		const command = poetry
			? ["poetry", "add", `${name}==${version}`]
			: ["uv", "add", ...(isFile(join(root, "uv.lock")) ? [] : ["--frozen"]), `${name}==${version}`];
		return runAndConfirm(lines, command, bump, () => checkPythonVersion(root, name, version));
	}

	if (["npm", "node", "pnpm", "yarn", "bun"].includes(ecosystem)) {
		let pm = detectNodePm(root);
		const cmds: Record<string, string[]> = {
			pnpm: ["pnpm", "update", `${name}@${version}`],
			bun: ["bun", "add", `${name}@${version}`],
			yarn: ["yarn", "add", `${name}@${version}`],
			npm: ["npm", "install", `${name}@${version}`],
		};
		if (!Object.hasOwn(cmds, pm)) pm = "npm";
		const command = cmds[pm];
		if (!command) return { exit: 1, text: lines.join("\n") };
		return runAndConfirm(lines, command, bump, () => checkNodeVersion(root, name, version));
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
