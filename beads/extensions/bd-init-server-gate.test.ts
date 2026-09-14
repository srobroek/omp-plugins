import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInitInvocations } from "./bd-init-advisory.ts";
import { collisionRefusal, databaseFor, decideBdInitServer, type GateEnvironment, MODE_REFUSAL } from "./bd-init-server-gate.ts";

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

describe("findInitInvocations values", () => {
	test("captures --prefix in both spellings and the -C directory", () => {
		expect(findInitInvocations("bd init --prefix myproj --skip-hooks")).toEqual([
			{ flags: ["--prefix", "--skip-hooks"], prefix: "myproj" },
		]);
		expect(findInitInvocations("bd init --prefix=myproj")).toEqual([{ flags: ["--prefix"], prefix: "myproj" }]);
		expect(findInitInvocations("bd -C /repo init --shared-server")).toEqual([
			{ flags: ["-C", "--shared-server"], dir: "/repo" },
		]);
	});
});

describe("decideBdInitServer: store mode", () => {
	test("refuses a plain init when neither flag nor environment selects the server", () => {
		const cwd = tmp("fresh");
		expect(decideBdInitServer("bd init --skip-hooks", cwd, gate([]))).toEqual({ block: true, reason: MODE_REFUSAL });
	});

	test("--shared-server, --server, or BEADS_DOLT_SHARED_SERVER=true satisfies the gate", () => {
		const cwd = tmp("fresh");
		expect(decideBdInitServer("bd init --shared-server --skip-hooks", cwd, gate([]))).toBeUndefined();
		expect(decideBdInitServer("bd init --server", cwd, gate([]))).toBeUndefined();
		expect(decideBdInitServer("bd init --init-if-missing", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "true" }))).toBeUndefined();
		// Any other value is not the carrier bd reads.
		expect(decideBdInitServer("bd init", cwd, gate([], { BEADS_DOLT_SHARED_SERVER: "1" }))).toEqual({ block: true, reason: MODE_REFUSAL });
	});

	test("a mention, --help, and unrelated commands are allowed", () => {
		const cwd = tmp("fresh");
		for (const command of ["echo bd init", "rg 'bd init' docs/", "bd init --help", "bd list --json", "git status"]) {
			expect(decideBdInitServer(command, cwd, gate([]))).toBeUndefined();
		}
	});

	test("wrapped and chained invocations are still read", () => {
		const cwd = tmp("fresh");
		expect(decideBdInitServer("cd x && env FOO=1 bd init", cwd, gate([]))).toEqual({ block: true, reason: MODE_REFUSAL });
		expect(decideBdInitServer("bd where; bd init --shared-server", cwd, gate([]))).toBeUndefined();
	});
});

describe("decideBdInitServer: prefix overlap", () => {
	test("the database name is the prefix, else the directory basename with dashes folded", () => {
		expect(databaseFor({ flags: [], prefix: "omp-orchestrate" }, "/x/y")).toBe("omp_orchestrate");
		expect(databaseFor({ flags: [] }, "/x/omp-orchestrate")).toBe("omp_orchestrate");
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

	test("-C names the directory the collision check reads", () => {
		const owner = tmp("owner");
		mkdirSync(join(owner, ".beads"));
		writeFileSync(join(owner, ".beads", "metadata.json"), JSON.stringify({ dolt_database: "owner" }));
		expect(decideBdInitServer(`bd -C ${owner} init --shared-server`, tmp("elsewhere"), gate(["owner"]))).toBeUndefined();
	});
});
