import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "find-tools-no-install.md");
function condition(): RegExp { const text = fs.readFileSync(RULE, "utf8"); const line = text.split(/\r?\n/).find(l => l.startsWith("condition:")); if (!line) throw new Error("no condition"); const pattern = (JSON.parse(line.slice("condition:".length).trim()) as string[])[0]; if (!pattern) throw new Error("empty condition"); return new RegExp(pattern, "u"); }
describe("find-tools-no-install", () => { const re = condition(); for (const input of ["npx skills add foo", "npx --yes skills add foo", "smithery mcp add foo"]) test(`fires: ${input}`, () => expect(re.test(input)).toBe(true)); for (const input of ["echo npx skills add foo", "sudo npx skills add foo"]) test(`holds: ${input}`, () => expect(re.test(input)).toBe(false)); });
