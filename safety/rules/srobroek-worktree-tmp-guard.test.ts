import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "srobroek-worktree-tmp-guard.md");
function condition(): RegExp { const text=fs.readFileSync(RULE,"utf8"); const fm=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text); if(!fm) throw new Error("no frontmatter"); const line=(fm[1] as string).split(/\r?\n/).find(l=>l.startsWith("condition:")); if(!line) throw new Error("no condition"); const p=(JSON.parse(line.slice(10).trim()) as string[])[0] as string; const f=/^\(\?([ims]+)\)/.exec(p); return f?new RegExp(p.slice(f[0].length),f[1]):new RegExp(p); }
const FIRE=["git worktree add /tmp/release", "echo ok && wt switch --create /private/tmp/agent"];
const HOLD=["echo \"git worktree add /tmp/release\"", 'bd create --description "git worktree add /tmp/x"', "git worktree add /var/tmp/release"];
describe("srobroek-worktree-tmp-guard",()=>{const re=condition(); for(const x of FIRE)test(`fires: ${x}`,()=>expect(re.test(x)).toBe(true)); for(const x of HOLD)test(`holds: ${x}`,()=>expect(re.test(x)).toBe(false));});
