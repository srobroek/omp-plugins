import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command, StartOptions, StartResult } from "./spec-start.ts";
import { startSpec } from "./spec-start.ts";

interface LockModule {
	embeddedStoreFor(cwd: string, env: NodeJS.ProcessEnv): string | undefined;
	embeddedWriteRunner(): { interpreter: string; script: string } | undefined;
	RUNNER_STORE_FLAG: string;
	RUNNER_WAIT_FLAG: string;
}
export interface RuntimeOptions extends StartOptions { beadsPlugin?: string; }
async function lockModule(plugin?: string): Promise<LockModule> {
	let specifier = "@srobroek/beads/embedded-write";
	if (plugin) {
		const root = realpathSync(resolve(plugin));
		const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "@srobroek/beads" || !("exports" in manifest) || !manifest.exports || typeof manifest.exports !== "object" || !("./embedded-write" in manifest.exports) || manifest.exports["./embedded-write"] !== "./dist/bd-embedded-write-lock.js") throw new Error("Selected package is not the matching Beads embedded-write provider");
		specifier = pathToFileURL(join(root, "dist", "bd-embedded-write-lock.js")).href;
	}
	let imported: unknown;
	// The installed plugin is runtime-selected; its locator must retain its own import.meta.dir.
	try { imported = await import(specifier); }
	catch { throw new Error("Beads embedded-write runtime unavailable. Install the matching beads plugin or provide its package directory with beadsPlugin / --beads-plugin; no ledger writes were attempted."); }
	if (!imported || typeof imported !== "object" || !("embeddedStoreFor" in imported) || typeof imported.embeddedStoreFor !== "function" || !("embeddedWriteRunner" in imported) || typeof imported.embeddedWriteRunner !== "function" || !("RUNNER_STORE_FLAG" in imported) || typeof imported.RUNNER_STORE_FLAG !== "string" || !("RUNNER_WAIT_FLAG" in imported) || typeof imported.RUNNER_WAIT_FLAG !== "string") throw new Error("Beads plugin does not export the embedded-write runtime");
	return imported as LockModule;
}
export async function runSpecStart(options: RuntimeOptions): Promise<StartResult> {
	const cwd = realpathSync(options.workspace);
	const env: NodeJS.ProcessEnv = { ...process.env, BEADS_DIR: realpathSync(join(cwd, ".beads")), GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS: "/usr/bin/false", SSH_ASKPASS_REQUIRE: "force", PAGER: "cat", GIT_PAGER: "cat", BD_NON_INTERACTIVE: "1", BD_NO_PAGER: "1" };
	delete env.BEADS_DOLT_SHARED_SERVER;
	const module = await lockModule(options.beadsPlugin);
	const store = module.embeddedStoreFor(cwd, env);
	const runner = module.embeddedWriteRunner();
	if (!store || !runner) throw new Error("Canonical embedded store or Beads write runner unavailable; no raw bd mutation fallback is allowed");
	const deadline = Date.now() + 25_000;
	const command: Command = args => {
		const { promise, resolve: resolveResult, reject } = Promise.withResolvers<unknown>();
		const remaining = deadline - Date.now();
		if (remaining <= 0) { reject(new Error("Workflow-start deadline exhausted; inspect the run before retrying")); return promise; }
		const child = spawn(runner.interpreter, [runner.script, module.RUNNER_STORE_FLAG, store, module.RUNNER_WAIT_FLAG, String(remaining), "--", "bd", ...args, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: remaining });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", bytes => { stdout += bytes.toString(); });
		child.stderr.on("data", bytes => { stderr += bytes.toString(); });
		child.on("error", reject);
		child.on("close", code => {
			if (code !== 0) { reject(new Error(stderr.trim() || `Beads command exited ${code}; inspect the run before retrying`)); return; }
			if (args[0] !== "query" && args[0] !== "show" && args[0] !== "mol") { resolveResult(undefined); return; }
			try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error("Beads returned invalid JSON; inspect the run before retrying")); }
		});
		return promise;
	};
	return startSpec(options, command);
}
