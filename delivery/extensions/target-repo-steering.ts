import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type GitRun = (argv: string[], cwd: string) => { exitCode: number; stdout: string };

type ReadResult = { text: string | null; error: boolean };

function canonicalRoot(target: string, run: GitRun): string | null {
	try {
		const result = run(["git", "rev-parse", "--show-toplevel"], target);
		if (result.exitCode !== 0) return null;
		const raw = result.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
		if (!raw) return null;
		return isAbsolute(raw) ? resolve(raw) : resolve(target, raw);
	} catch {
		return null;
	}
}

function readRegularFile(path: string): ReadResult {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) return { text: null, error: false };
		try {
			return { text: readFileSync(path, "utf8"), error: false };
		} catch {
			return { text: null, error: true };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: null, error: false };
		return { text: null, error: true };
	}
}

function directivePresent(text: string, directive: string): boolean {
	return text.split(/\r?\n/).some((line) => line === directive);
}

function inspectFile(path: string, affirmative: string, veto: string): {
	affirmative: boolean;
	veto: boolean;
	error: boolean;
} {
	const result = readRegularFile(path);
	if (result.text === null) return { affirmative: false, veto: false, error: result.error };
	return {
		affirmative: directivePresent(result.text, affirmative),
		veto: directivePresent(result.text, veto),
		error: false,
	};
}

/**
 * Return whether the target repository itself authorizes an environment override.
 *
 * Only exact standalone directive lines in non-symlink root AGENTS.md/CLAUDE.md files or direct
 * non-symlink .omp/rules/*.md files count. Missing optional sources are harmless; any other
 * filesystem error denies the override. A veto in any readable source wins over every affirmative.
 */
export function targetRepoAuthorizes(target: string, envName: string, run: GitRun): boolean {
	const root = canonicalRoot(target, run);
	if (root === null) return false;
	const affirmative = `MUST authorize ${envName}=1 for this repository.`;
	const veto = `MUST NOT authorize ${envName}=1 for this repository.`;
	let foundAffirmative = false;
	let foundVeto = false;
	let filesystemError = false;

	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const result = inspectFile(resolve(root, name), affirmative, veto);
		foundAffirmative ||= result.affirmative;
		foundVeto ||= result.veto;
		filesystemError ||= result.error;
	}

	const omp = resolve(root, ".omp");
	const rules = resolve(omp, "rules");
	try {
		const ompStat = lstatSync(omp);
		if (ompStat.isDirectory() && !ompStat.isSymbolicLink()) {
			try {
				const rulesStat = lstatSync(rules);
				if (rulesStat.isDirectory() && !rulesStat.isSymbolicLink()) {
					try {
						for (const name of readdirSync(rules)) {
							if (!name.endsWith(".md")) continue;
							const result = inspectFile(resolve(rules, name), affirmative, veto);
							foundAffirmative ||= result.affirmative;
							foundVeto ||= result.veto;
							filesystemError ||= result.error;
						}
					} catch {
						filesystemError = true;
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") filesystemError = true;
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") filesystemError = true;
	}

	return foundAffirmative && !foundVeto && !filesystemError;
}

export function steeringDirective(envName: string): string {
	return `MUST authorize ${envName}=1 for this repository.`;
}
