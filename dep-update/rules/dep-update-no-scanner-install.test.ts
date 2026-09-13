import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "dep-update-no-scanner-install.md");
function conditions(): RegExp[] { const text = fs.readFileSync(RULE, "utf8"); const line = text.split(/\r?\n/).find(l => l.startsWith("condition:")); if (!line) throw new Error("no condition"); return (JSON.parse(line.slice("condition:".length).trim()) as string[]).map(p => new RegExp(p, "u")); }
describe("dep-update-no-scanner-install", () => { const res = conditions(); for (const input of ["pip install pip-audit", "cargo install cargo-audit", "go install golang.org/x/vuln/cmd/govulncheck@latest", "npm i -g osv-scanner"]) test(`fires: ${input}`, () => expect(res.some(re => re.test(input))).toBe(true)); for (const input of ["uvx pip-audit", "npx osv-scanner", "echo \"pip install pip-audit\"", "printf 'cargo install cargo-audit'"]) test(`holds: ${input}`, () => expect(res.some(re => re.test(input))).toBe(false)); });
