import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "speckit-implement-deprecated.md");
function condition(): RegExp { const text = fs.readFileSync(RULE, "utf8"); const line = text.split(/\r?\n/).find(l => l.startsWith("condition:")); if (!line) throw new Error("no condition"); const raw = (JSON.parse(line.slice("condition:".length).trim()) as string[])[0]; if (!raw) throw new Error("empty condition"); const flags = /^\(\?([ims]+)\)/.exec(raw); return flags ? new RegExp(raw.slice(flags[0].length), flags[1]) : new RegExp(raw, "u"); }
describe("speckit-implement-deprecated text", () => { const re = condition(); for (const input of ["/speckit.implement", "Please use /speckit-implement now"]) test(`fires: ${input}`, () => expect(re.test(input)).toBe(true)); for (const input of ["speckit-implement --dry-run", "bd create --description \"mentions speckit.implement\"", "printf speckit.implementation"]) test(`holds: ${input}`, () => expect(re.test(input)).toBe(false)); });
