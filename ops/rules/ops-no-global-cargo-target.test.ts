import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE=path.join(import.meta.dir,"ops-no-global-cargo-target.md");
function conditions():RegExp[]{const t=fs.readFileSync(RULE,"utf8");const fm=/^---\r?\n([\s\S]*?)\r?\n---/.exec(t);if(!fm)throw new Error("no frontmatter");const l=(fm[1] as string).split(/\r?\n/).find(x=>x.startsWith("condition:"));if(!l)throw new Error("no condition");return (JSON.parse(l.slice(10).trim()) as string[]).map(p=>{const f=/^\(\?([ims]+)\)/.exec(p);return f?new RegExp(p.slice(f[0].length),f[1]):new RegExp(p);});}
const FIRE=["target-dir = \"/tmp/shared\"","export CARGO_TARGET_DIR=/tmp/shared","CARGO_TARGET_DIR: /tmp/shared"];
const HOLD=["echo target-dir = /tmp/shared","cargo build"];
describe("ops-no-global-cargo-target",()=>{const rs=conditions();for(const x of FIRE)test(`fires: ${x}`,()=>expect(rs.some(r=>r.test(x))).toBe(true));for(const x of HOLD)test(`holds: ${x}`,()=>expect(rs.some(r=>r.test(x))).toBe(false));});
