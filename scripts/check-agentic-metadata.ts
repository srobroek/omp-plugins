#!/usr/bin/env bun
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { lint, parseFrontmatter } from "../authoring/extensions/agentic-lint-tool.ts";

// Discovery identity is checked separately by check-contract.py. Reuse the
// authoring validator for YAML and runtime metadata, not historical prose style.
const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
const counts = { rules: 0, agents: 0, skills: 0 };
let failed = false;
try {
	for (const plugin of readdirSync(root, { withFileTypes: true })) {
		if (!plugin.isDirectory() || plugin.name.startsWith(".") || ["node_modules", "scripts", "examples"].includes(plugin.name)) continue;
		const base = join(root, plugin.name);
		for (const kind of ["rules", "agents", "skills"] as const) {
			const directory = join(base, kind);
			let entries;
			try { entries = readdirSync(directory, { withFileTypes: true }); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				if (kind === "skills" ? !entry.isDirectory() : !entry.isFile() || !entry.name.endsWith(".md")) continue;
				const path = kind === "skills" ? join(directory, entry.name, "SKILL.md") : join(directory, entry.name);
				counts[kind]++;
				for (const [severity, code, message] of lint(path)) {
					if (code !== "E13" && code !== "E14") continue;
					console.error(`${path}: ${severity} ${code}: ${message}`);
					if (severity === "ERROR") failed = true;
				}
				if (kind === "agents") {
					const metadata = parseFrontmatter(readFileSync(path, "utf8")).parsed;
					for (const field of ["model", "thinking-level"] as const) {
						if (typeof metadata?.[field] === "string" && metadata[field].trim()) continue;
						console.error(`${path}: ERROR E14: agent ${field} must be a nonempty string`);
						failed = true;
					}
					const tools = metadata?.tools;
					if (typeof tools !== "string" || tools.split(",").some(tool => !tool.trim())) {
						console.error(`${path}: ERROR E14: agent tools must be a nonempty comma-separated string`);
						failed = true;
					}
				}
			}
		}
	}
} catch (error) {
	console.error(`FAIL: metadata validation incomplete: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
console.log(`checked ${counts.rules} rules, ${counts.agents} agents, ${counts.skills} skills`);
if (Object.values(counts).some(count => count === 0)) {
	console.error("FAIL: shipped asset kind missing from metadata coverage");
	failed = true;
}
console.log(failed ? "FAIL: shipped metadata contract" : "PASS: every shipped asset passed metadata validation");
process.exit(failed ? 1 : 0);
