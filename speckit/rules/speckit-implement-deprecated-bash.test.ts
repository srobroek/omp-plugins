import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
const RULE = path.join(import.meta.dir, "speckit-implement-deprecated-bash.md");
function condition(): RegExp { const text = fs.readFileSync(RULE, "utf8"); const line = text.split(/\r?\n/).find(l => l.startsWith("condition:")); if (!line) throw new Error("no condition"); const [pattern] = JSON.parse(line.slice("condition:".length).trim()) as string[]; return new RegExp(pattern, "u"); }
describe("speckit-implement-deprecated bash", () => { const re = condition(); for (const input of ["speckit-implement --dry-run", "echo ok; speckit-implement"]) test(`fires: ${input}`, () => expect(re.test(input)).toBe(true)); for (const input of ["echo speckit-implement", "bd create --description \"mentions speckit-implement\"", "/speckit.implement"]) test(`holds: ${input}`, () => expect(re.test(input)).toBe(false)); });
