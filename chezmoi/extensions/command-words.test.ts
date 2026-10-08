import { describe, expect, test } from "bun:test";

import { commandWords } from "./command-words.ts";

const words = (command: string): string[] => command.split(" ");

// One copy is tested: scripts/check-shared-detector.py keeps every copy byte-identical.
describe("commandWords", () => {
	test.each([
		["sudo -u root npm i", ["npm", "i"]],
		["/usr/bin/sudo -iu root npm i", ["npm", "i"]],
		["doas -u root tee f", ["tee", "f"]],
		["env CI=1 -u HOME --unset=PATH npm ci", ["npm", "ci"]],
		["env - npm ci", ["npm", "ci"]],
		["FOO=1 BAR=2 nohup time -p npm ci", ["npm", "ci"]],
		["nice -n 5 tee f", ["tee", "f"]],
		["nice -5 tee f", ["tee", "f"]],
		["nice --adjustment=5 tee f", ["tee", "f"]],
		["timeout 5 tee f", ["tee", "f"]],
		["timeout -k 1 -s KILL --preserve-status 5s tee f", ["tee", "f"]],
		["timeout -- 5 tee f", ["tee", "f"]],
		["stdbuf -oL -e 0 --input=L tee f", ["tee", "f"]],
		["exec -a name -c tee f", ["tee", "f"]],
		["/usr/bin/time -o out -f %e tee f", ["tee", "f"]],
		["command -p tee f", ["tee", "f"]],
		["sudo -- nice tee f", ["tee", "f"]],
		["-- tee f", ["tee", "f"]],
	])("%s runs %j", (command, argv) => {
		expect(commandWords(words(command)).argv).toEqual(argv);
	});

	test("a lookup, a bare wrapper, or a missing option value runs nothing", () => {
		for (const command of ["command -v npm", "command -pV npm", "exec", "sudo -u", "CI=1"]) {
			expect({ command, argv: commandWords(words(command)).argv }).toEqual({ command, argv: [] });
		}
	});

	test("env -S splits its value into words that may hold more options and wrappers", () => {
		expect(commandWords(["env", "-S", "npm i x"]).argv).toEqual(["npm", "i", "x"]);
		expect(commandWords(["env", "-S-i CI=1 sudo npm ci", "--silent"]).argv).toEqual(["npm", "ci", "--silent"]);
		expect(commandWords(["env", "--split-string=-C /repo tee f"])).toEqual({ argv: ["tee", "f"], directories: ["/repo"] });
		expect(commandWords(["env", "-S", "-S"]).argv).toEqual([]);
	});

	test("directories are the wrappers' working directories, outermost first and as written", () => {
		expect(commandWords(words("env -C /a sudo -D b --chdir=c tee f"))).toEqual({ argv: ["tee", "f"], directories: ["/a", "b", "c"] });
		expect(commandWords(words("sudo --chdir ~ env -C~/x tee f"))).toEqual({ argv: ["tee", "f"], directories: ["~", "~/x"] });
		expect(commandWords(words("tee -C f"))).toEqual({ argv: ["tee", "-C", "f"], directories: [] });
	});

	test("words after the command are left alone", () => {
		expect(commandWords(words("npm exec sudo -u root x")).argv).toEqual(["npm", "exec", "sudo", "-u", "root", "x"]);
	});
});
