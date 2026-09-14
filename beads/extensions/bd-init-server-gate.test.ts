import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findInitInvocations } from "./bd-init-advisory.ts";
import {
	collisionRefusal,
	databaseFor,
	decideBdInitServer,
	type GateEnvironment,
	MODE_REFUSAL,
	PARSE_REFUSAL,
} from "./bd-init-server-gate.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
	const parent = mkdtempSync(join(tmpdir(), "bd-init-gate-"));
	dirs.push(parent);
	const dir = join(parent, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** A gate whose shared server holds exactly `databases`, under the given environment. */
function gate(databases: string[], env: NodeJS.ProcessEnv = {}): GateEnvironment {
	const sharedServerDataDir = tmp("dolt");
	for (const name of databases) mkdirSync(join(sharedServerDataDir, name));
	return { env, sharedServerDataDir };
}

const BLOCK_MODE = { block: true, reason: MODE_REFUSAL } as const;
const BLOCK_PARSE = { block: true, reason: PARSE_REFUSAL } as const;

describe("findInitInvocations values", () => {
	test("captures --prefix in both spellings, bd's own -C, and the shell cwd", () => {
		expect(findInitInvocations("bd init --prefix myproj --skip-hooks", "/w")).toEqual([
			{ flags: ["--prefix", "--skip-hooks"], prefix: "myproj", cwd: "/w", env: {}, cleared: false },
		]);
		expect(findInitInvocations("bd init --prefix=myproj")).toEqual([{ flags: ["--prefix"], prefix: "myproj", env: {}, cleared: false }]);
		expect(findInitInvocations("bd -C /repo init --shared-server", "/w")).toEqual([
			{ flags: ["-C", "--shared-server"], dir: "/repo", cwd: "/w", env: {}, cleared: false },
		]);
	});

	test("follows cd, env -C, and sudo -D; marks an unfollowable cd unknown", () => {
		expect(findInitInvocations("cd other && bd init", "/w")[0]?.cwd).toBe("/w/other");
		expect(findInitInvocations("cd /abs; cd sub\nbd init", "/w")[0]?.cwd).toBe("/abs/sub");
		expect(findInitInvocations("env -C /x bd init", "/w")[0]?.cwd).toBe("/x");
		expect(findInitInvocations("sudo -D /y bd init", "/w")[0]?.cwd).toBe("/y");
		expect(findInitInvocations("cd - && bd init", "/w")[0]?.cwd).toBeUndefined();
		expect(findInitInvocations('cd "$DIR" && bd init', "/w")[0]?.cwd).toBeUndefined();
	});

	test("collects the environment the command line sets or clears", () => {
		expect(findInitInvocations("BEADS_DOLT_SHARED_SERVER=1 bd init")[0]?.env).toEqual({ BEADS_DOLT_SHARED_SERVER: "1" });
		expect(findInitInvocations("env BEADS_DOLT_SHARED_SERVER=true bd init")[0]?.env).toEqual({ BEADS_DOLT_SHARED_SERVER: "true" });
		expect(findInitInvocations("env -u BEADS_DOLT_SHARED_SERVER bd init")[0]?.env).toEqual({ BEADS_DOLT_SHARED_SERVER: undefined });
		expect(findInitInvocations("env -i bd init")[0]?.cleared).toBe(true);
		expect(findInitInvocations("sudo FOO=1 bd init")[0]?.env).toEqual({ FOO: "1" });
	});

	test("sees bd through paths, wrappers with options, and a literal sh -c", () => {
		for (const command of [
			"/usr/bin/bd init",
			"exec bd init",
			"exec -a beads bd init",
			"env -u X bd init",
			"command -- bd init",
			"sudo -u build bd init",
			"sudo -E -u build -- bd init",
			"nice -n 10 bd init",
			"nohup bd init",
			"timeout 30 bd init",
			"timeout -k 5 30 bd init",
			"mise exec node@20 -- bd init",
			"sh -c 'bd init'",
			"bash -lc 'cd x && bd init'",
			"stdbuf -oL bd init",
		]) {
			expect(findInitInvocations(command, "/w").length, command).toBe(1);
		}
		expect(findInitInvocations("bash -lc 'cd x && bd init'", "/w")[0]?.cwd).toBe("/w/x");
	});

	test("a mention is not an invocation; an unfollowable wrapper is flagged", () => {
		for (const command of ["echo bd init", "rg 'bd init' docs/", "git commit -m 'bd init'", "bash script.sh bd init", "bd init-db"]) {
			expect(findInitInvocations(command), command).toEqual([]);
		}
		expect(findInitInvocations("mise exec bd init")[0]?.unresolved).toBe(true);
		expect(findInitInvocations("env -S 'bd init'")[0]?.unresolved ?? findInitInvocations("env -S bd init")[0]?.unresolved).toBe(true);
		expect(findInitInvocations('sh -c "bd init $X"')[0]?.unresolved).toBe(true);
	});
});

describe("decideBdInitServer: store mode", () => {
	test("refuses a plain init when neither flag nor environment selects the server", () => {
		expect(decideBdInitServer("bd init --skip-hooks", tmp("fresh"), gate([]))).toEqual(BLOCK_MODE);
	});

	test("--shared-server, --server, or BEADS_DOLT_SHARED_SERVER (true or 1) satisfies the gate", () => {
		const cwd = tmp("fresh");
		expect(decideBdInitServer("bd init --shared-server --skip-hooks", cwd, gate([]))).toBeUndefined();
		expect(decideBdInitServer("bd init --server", cwd, gate([]))).toBeUndefined();
		expect(decideBdInitServer("bd init --init-if-missing", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "true" }))).toBeUndefined();
		expect(decideBdInitServer("bd init", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "1" }))).toBeUndefined();
		// bd reads only `true` and `1` (verified 2026-09-14); anything else is not the carrier.
		expect(decideBdInitServer("bd init", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "yes" }))).toEqual(BLOCK_MODE);
	});

	test("the effective environment is process, then the call's env, then the command line", () => {
		const cwd = tmp("fresh");
		expect(decideBdInitServer("bd init", cwd, gate([]), { BEADS_DOLT_SHARED_SERVER: "true" })).toBeUndefined();
		expect(decideBdInitServer("bd init", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "true" }), { BEADS_DOLT_SHARED_SERVER: "false" })).toEqual(BLOCK_MODE);
		expect(decideBdInitServer("BEADS_DOLT_SHARED_SERVER=1 bd init", cwd, gate([]))).toBeUndefined();
		expect(decideBdInitServer("env -u BEADS_DOLT_SHARED_SERVER bd init", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "true" }))).toEqual(BLOCK_MODE);
		expect(decideBdInitServer("env -i bd init", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "true" }))).toEqual(BLOCK_MODE);
	});

	test("a mention, --help, and unrelated commands are allowed", () => {
		const cwd = tmp("fresh");
		for (const command of ["echo bd init", "rg 'bd init' docs/", "bd init --help", "bd list --json", "git status"]) {
			expect(decideBdInitServer(command, cwd, gate([])), command).toBeUndefined();
		}
	});

	test("wrapped, pathed, and chained invocations are still gated; unfollowable ones fail closed", () => {
		const cwd = tmp("fresh");
		for (const command of ["/usr/bin/bd init", "exec bd init", "sudo -u build bd init", "sh -c 'bd init'", "cd x && env FOO=1 bd init", "timeout 30 bd init"]) {
			expect(decideBdInitServer(command, cwd, gate([])), command).toEqual(BLOCK_MODE);
		}
		expect(decideBdInitServer("bd where; bd init --shared-server", cwd, gate([]))).toBeUndefined();
		expect(decideBdInitServer("mise exec bd init --shared-server", cwd, gate([]))).toEqual(BLOCK_PARSE);
		expect(decideBdInitServer("cd - && bd init --shared-server", cwd, gate([]))).toEqual(BLOCK_PARSE);
	});
});

describe("decideBdInitServer: prefix overlap", () => {
	test("the database name is the prefix, else the directory basename with dashes folded", () => {
		expect(databaseFor({ flags: [], prefix: "omp-orchestrate", env: {}, cleared: false }, "/x/y")).toBe("omp_orchestrate");
		expect(databaseFor({ flags: [], env: {}, cleared: false }, "/x/omp-orchestrate")).toBe("omp_orchestrate");
	});

	test("refuses when the server already holds the database and the checkout does not own it", () => {
		const cwd = tmp("omp-orchestrate");
		const g = gate(["omp_orchestrate"]);
		expect(decideBdInitServer("bd init --shared-server", cwd, g)).toEqual({ block: true, reason: collisionRefusal("omp_orchestrate") });
		expect(decideBdInitServer("bd init --shared-server --prefix omp-orchestrate", tmp("other"), g)).toEqual({
			block: true,
			reason: collisionRefusal("omp_orchestrate"),
		});
	});

	test("a checkout that pins the same dolt_database may re-init; a different prefix is free", () => {
		const cwd = tmp("omp-orchestrate");
		mkdirSync(join(cwd, ".beads"));
		writeFileSync(join(cwd, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_database: "omp_orchestrate" }));
		const g = gate(["omp_orchestrate"]);
		expect(decideBdInitServer("bd init --shared-server --reinit-local", cwd, g)).toBeUndefined();
		expect(decideBdInitServer("bd init --shared-server --prefix fresh", tmp("other"), g)).toBeUndefined();
	});

	test("-C and a preceding cd name the directory the collision check reads", () => {
		const owner = tmp("owner");
		mkdirSync(join(owner, ".beads"));
		writeFileSync(join(owner, ".beads", "metadata.json"), JSON.stringify({ dolt_database: "owner" }));
		const elsewhere = tmp("elsewhere");
		expect(decideBdInitServer(`bd -C ${owner} init --shared-server`, elsewhere, gate(["owner"]))).toBeUndefined();
		expect(decideBdInitServer(`cd ${owner} && bd init --shared-server`, elsewhere, gate(["owner"]))).toBeUndefined();
		// From an unrelated directory the same database is a collision.
		expect(decideBdInitServer("bd init --shared-server", tmp("owner"), gate(["owner"]))).toEqual({ block: true, reason: collisionRefusal("owner") });
	});
});
