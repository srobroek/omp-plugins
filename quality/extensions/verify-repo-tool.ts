import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** A tool_call has a 30,000 ms budget; leave 5,000 ms for dispatch and reporting. */
export const TIMEOUT_MS = 25_000;

type VerifyParams = {
	path?: string;
};

export type VerifyResult = {
	ok: boolean;
	complete: boolean;
	exitCode: number;
	report: string;
	ran: number;
	skipped: number;
	failed: number;
	failures: string[];
	error?: string;
};

/**
 * Per-probe bound. Each probe is one spawn, and every one of these binaries is a
 * mise shim that pays its own resolution on each spawn, so the cost is not a
 * local lookup. Measured warm, first successful argument set: pyright 2689 ms,
 * tsc 2388 ms, biome 2089 ms, rustfmt 1651 ms, cargo 1110 ms, ruff 953 ms, go
 * 736 ms. At 1000 ms five of those seven installed tools were killed and
 * reported not runnable, which inverts what this probe is for: it exists so a
 * resolvable-but-broken shim cannot count as present, not so a working tool can
 * be called absent. 5000 ms clears the slowest measured probe by 1.9x.
 *
 * Affordable only because the manifest is checked first. A repository with no
 * project for this language probes nothing, so an empty runner pays zero rather
 * than three binaries times three argument sets.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Argument sets tried in order until one exits 0, matching the four quality
 * tools and `sniff-install-tool`.
 *
 * No single flag covers these binaries: most answer `--version`; `go` answers
 * `version` and rejects `--version`; `gofmt` has no version verb and answers
 * only help. A generic `--version` probe would report `go` and `gofmt` missing
 * and silently skip their checks.
 */
const PROBE_ARGS: readonly (readonly string[])[] = [["--version"], ["version"], ["-h"]];

/**
 * Whether `bin` can actually RUN, not merely resolve.
 *
 * `command -v` succeeds for a mise shim whose tool is not installed, so a
 * resolve-only check counted a shim as available and the step then failed on
 * execution -- reporting a verification FAILURE where the truth was a missing
 * tool. Measured on one machine: mypy, pylint and vulture each resolve and each
 * fail with `mise ERROR No version is set for shim`.
 */
function have(bin: string, deadline = Date.now() + TIMEOUT_MS): boolean {
	for (const args of PROBE_ARGS) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		try {
			const proc = Bun.spawnSync([bin, ...args], {
				// Closed stdin, so a probe never waits on input.
				stdin: new Uint8Array(),
				stdout: "pipe",
				stderr: "pipe",
				timeout: Math.min(PROBE_TIMEOUT_MS, remaining),
			});
			if (proc.exitCode === 0 && proc.exitedDueToTimeout !== true && Date.now() < deadline) return true;
		} catch {
			return false;
}
	}
	return false;
}

function installedPythonTool(bin: string, cwd: string, deadline: number): string | null {
	for (const dir of [join(cwd, ".venv", "bin"), join(cwd, "node_modules", ".bin")]) {
		const path = join(dir, bin);
		if (existsSync(path)) return path;
}
	return have(bin, deadline) ? bin : null;
}

function fileExists(cwd: string, name: string): boolean {
	return existsSync(join(cwd, name));
}

function runCmd(
	cwd: string,
	label: string,
	argv: string[],
	lines: string[],
	state: { ran: number; failed: number; failures: string[] },
	deadline: number,
): void {
	lines.push(`==> ${label}`);
	lines.push(`+ ${argv.join(" ")}`);
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		const message = `${label} skipped: verification event budget exhausted`;
		lines.push(message);
		state.failed += 1;
		state.failures.push(message);
		return;
}
	try {
		const proc = Bun.spawnSync(argv, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			timeout: Math.min(TIMEOUT_MS, remaining),
		});
		const out = proc.stdout.toString().slice(0, 16_384);
		const err = proc.stderr.toString().slice(0, 16_384);
		if (out) lines.push(out.replace(/\n$/, ""));
		if (err) lines.push(err.replace(/\n$/, ""));
		state.ran += 1;
		if (proc.exitCode !== 0 || proc.exitedDueToTimeout === true || Date.now() >= deadline) {
			state.failed += 1;
			const suffix = proc.exitedDueToTimeout === true ? "timed out" : `exited ${proc.exitCode}`;
			state.failures.push(`${label} ${suffix}: ${argv.join(" ")}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		state.ran += 1;
		state.failed += 1;
		state.failures.push(`${label} exited spawn-error: ${message}`);
		lines.push(message);
	}
}

function skip(reason: string, lines: string[], state: { skipped: number }): void {
	lines.push(`==> skip: ${reason}`);
	state.skipped += 1;
}

type Pkg = { scripts?: Record<string, string>; packageManager?: string };

function readPkg(cwd: string): Pkg | null {
	try {
		return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as Pkg;
	} catch {
		return null;
	}
}
function hasScript(pkg: Pkg, name: string): boolean {
	const v = pkg.scripts?.[name];
	return typeof v === "string" && v.length > 0;
}

function detectJsRunner(cwd: string, deadline: number): string | null {
    const declared = readPkg(cwd)?.packageManager;
    if (declared !== undefined) {
        if (typeof declared !== "string") return null;
        const manager = declared.split("@")[0] ?? "";
        return ["npm", "pnpm", "bun", "yarn"].includes(manager) && have(manager, deadline) ? manager : null;
    }
    if (fileExists(cwd, "pnpm-lock.yaml")) return have("pnpm", deadline) ? "pnpm" : null;
    if (fileExists(cwd, "bun.lock") || fileExists(cwd, "bun.lockb")) return have("bun", deadline) ? "bun" : null;
    if (fileExists(cwd, "yarn.lock")) return have("yarn", deadline) ? "yarn" : null;
    if (have("npm", deadline)) return "npm";
    return null;
}

function runJsScript(
    cwd: string,
    runner: string,
    script: string,
    lines: string[],
    state: { ran: number; failed: number; failures: string[] },
    deadline: number,
): void {
    const argv = [runner, "run", script];
    runCmd(cwd, `package script: ${script}`, argv, lines, state, deadline);
}

function runJsExec(
    cwd: string,
    label: string,
    toolArgv: [string, ...string[]],
    lines: string[],
    state: { ran: number; skipped: number; failed: number; failures: string[] },
    deadline: number,
): void {
    const [bin, ...args] = toolArgv;
    const local = join(cwd, "node_modules", ".bin", bin);
    if (existsSync(local) || have(bin, deadline)) {
        runCmd(cwd, label, [existsSync(local) ? local : bin, ...args], lines, state, deadline);
    } else {
        skip(`${label}: ${bin} is not installed`, lines, state);
    }
}

export function resolveVerifyPath(raw: string, base = process.cwd()): string {
    if (!raw.includes("://") && !raw.startsWith("file:")) return resolve(base, raw);
    if (!raw.startsWith("file:")) throw new Error(`unsupported repository URL: ${raw}`);
    return fileURLToPath(raw);
}

export function runVerify(cwd: string): VerifyResult {
    cwd = resolve(cwd);
    const deadline = Date.now() + TIMEOUT_MS;
    const lines: string[] = [];
    const state = { ran: 0, skipped: 0, failed: 0, failures: [] as string[] };

    if (fileExists(cwd, "justfile") || fileExists(cwd, "Justfile")) {
        if (have("just", deadline)) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) skip("verification event budget exhausted before just --list", lines, state);
            else {
                const listed = Bun.spawnSync(["just", "--list"], { cwd, stdout: "pipe", stderr: "pipe", timeout: Math.min(15_000, remaining) });
                const text = listed.stdout.toString() + listed.stderr.toString();
                if (listed.exitCode !== 0 || listed.exitedDueToTimeout === true) {
                    state.failed += 1;
                    state.failures.push(`just --list ${listed.exitedDueToTimeout === true ? "timed out" : `exited ${listed.exitCode}`}`);
                    lines.push(text.slice(0, 16_384));
                } else if (/(^|\n)[ \t]*verify([ \t\r\n]|$)/.test(text)) runCmd(cwd, "just verify", ["just", "verify"], lines, state, deadline);
            }
        } else skip("justfile present but just is not installed", lines, state);
    }

    if (fileExists(cwd, "Makefile")) {
        if (have("make", deadline)) {
            const mk = readFileSync(join(cwd, "Makefile"), "utf8");
            if (/^verify:/m.test(mk)) runCmd(cwd, "make verify", ["make", "verify"], lines, state, deadline);
        } else skip("Makefile present but make is not installed", lines, state);
    }

    if (fileExists(cwd, "package.json")) {
        const runner = detectJsRunner(cwd, deadline);
        const pkg = readPkg(cwd);
        if (!runner) skip("package.json present but no supported JS package runner is installed", lines, state);
        else if (!pkg) skip("package.json present but could not be parsed", lines, state);
        else if (hasScript(pkg, "verify")) runJsScript(cwd, runner, "verify", lines, state, deadline);
        else {
            for (const script of ["typecheck", "lint", "test", "build"]) if (hasScript(pkg, script)) runJsScript(cwd, runner, script, lines, state, deadline);
            if (fileExists(cwd, "tsconfig.json") && !hasScript(pkg, "typecheck")) runJsExec(cwd, "TypeScript check", ["tsc", "--noEmit"], lines, state, deadline);
        }
    }

    if (fileExists(cwd, "Cargo.toml")) {
        if (have("cargo", deadline)) {
            runCmd(cwd, "cargo fmt", ["cargo", "fmt", "--check"], lines, state, deadline);
            runCmd(cwd, "cargo clippy", ["cargo", "clippy", "--all-targets", "--all-features", "--", "-D", "warnings"], lines, state, deadline);
            runCmd(cwd, "cargo test", ["cargo", "test"], lines, state, deadline);
        } else skip("Cargo.toml present but cargo is not installed", lines, state);
    }

    if (fileExists(cwd, "go.mod")) {
        if (have("go", deadline)) {
            if (have("golangci-lint", deadline)) runCmd(cwd, "golangci-lint", ["golangci-lint", "run"], lines, state, deadline);
            else skip("golangci-lint is not installed", lines, state);
            runCmd(cwd, "go test", ["go", "test", "./..."], lines, state, deadline);
            runCmd(cwd, "go build", ["go", "build", "./..."], lines, state, deadline);
        } else skip("go.mod present but go is not installed", lines, state);
    }

    if (fileExists(cwd, "pyproject.toml") || fileExists(cwd, "requirements.txt")) {
        const ruff = installedPythonTool("ruff", cwd, deadline);
        if (ruff) {
            runCmd(cwd, "ruff check", [ruff, "check", "."], lines, state, deadline);
            runCmd(cwd, "ruff format", [ruff, "format", "--check", "."], lines, state, deadline);
        } else skip("ruff is not installed", lines, state);
        const pyright = installedPythonTool("pyright", cwd, deadline);
        if (pyright) runCmd(cwd, "pyright", [pyright, "."], lines, state, deadline);
        else skip("pyright is not installed", lines, state);
        const pytest = installedPythonTool("pytest", cwd, deadline);
        if (pytest) runCmd(cwd, "pytest", [pytest], lines, state, deadline);
        else skip("pytest is not installed", lines, state);
    }

    if (Date.now() >= deadline) lines.push("Verification stopped at the 25 s event budget; report contains completed work only.");
    lines.push("==> summary");
    lines.push(`ran: ${state.ran}`);
    lines.push(`skipped: ${state.skipped}`);
    lines.push(`failed: ${state.failed}`);
    if (state.ran === 0) {
        lines.push("No supported verification workflow detected.");
        return { ok: false, complete: false, exitCode: 1, report: lines.join("\n"), ...state };
    }
    if (state.failed !== 0 || state.skipped !== 0) {
        lines.push("Failures:");
        for (const f of state.failures) lines.push(`- ${f}`);
        return { ok: false, complete: state.skipped === 0 && Date.now() < deadline, exitCode: 1, report: lines.join("\n"), ...state };
    }
    return { ok: true, complete: true, exitCode: 0, report: lines.join("\n"), ...state };
}

export default function verifyRepoTool(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "verify_repo",
		label: "Verify repository",
		description:
			"Detect and run the polyglot verify workflow (just/make/package/cargo/go/python checks) and return the final report.",
		parameters: z.object({
			path: z
				.string()
				.optional()
				.describe("Repository cwd; defaults to the current working directory"),
		}) as unknown as TSchema,
		execute: async (_toolCallId, params: VerifyParams, _signal, _onUpdate, ctx) => {
			const cwd = resolveVerifyPath(params.path ?? ".", ctx?.cwd ?? process.cwd());
			try {
				const result = runVerify(cwd);
				return {
					content: [{ type: "text", text: result.report }],
					details: {
						ok: result.ok,
						complete: result.complete,
						exitCode: result.exitCode,
						path: cwd,
						ran: result.ran,
						skipped: result.skipped,
						failed: result.failed,
						failures: result.failures,
					},
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `verify_repo failed: ${message}` }],
					details: { ok: false, error: message, path: cwd },
				};
			}
		},
	});
}

if (import.meta.main) {
	const cwd = process.argv[2] ?? process.cwd();
	const result = runVerify(cwd);
	console.log(result.report);
	process.exit(result.exitCode);
}
