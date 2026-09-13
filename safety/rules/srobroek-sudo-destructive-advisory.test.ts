import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const RULE = path.join(import.meta.dir, "srobroek-sudo-destructive-advisory.md");
function condition(): RegExp {
	const text = fs.readFileSync(RULE, "utf8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!frontmatter) throw new Error("no frontmatter");
	const line = (frontmatter[1] as string).split(/\r?\n/).find(l => l.startsWith("condition:"));
	if (!line) throw new Error("no condition");
	const pattern = (JSON.parse(line.slice("condition:".length).trim()) as string[])[0] as string;
	const flags = /^\(\?([ims]+)\)/.exec(pattern);
	return flags ? new RegExp(pattern.slice(flags[0].length), flags[1]) : new RegExp(pattern);
}
const FIRE = ["sudo rm -rf /var/tmp/cache", "echo ok && sudo chmod -R 777 /srv/app"];
const HOLD = ["echo \"sudo rm -rf /\"", 'bd create --description "never sudo rm files"', "sudo -u builder id"];
describe("srobroek-sudo-destructive-advisory", () => {
	const re = condition();
	for (const value of FIRE) test(`fires: ${value}`, () => expect(re.test(value)).toBe(true));
	for (const value of HOLD) test(`holds: ${value}`, () => expect(re.test(value)).toBe(false));
});
