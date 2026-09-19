import { describe, expect, test } from "bun:test";
import { candidatesForChannel, parseProfilesIni, resolveBrowser, resolveSourceProfile, selectFirefoxProfile } from "./lib/discovery.ts";

describe("headed browser discovery", () => {
	test("builds platform-specific candidates", () => {
		expect(candidatesForChannel("zen", { platform: "darwin", home: "/Users/test" })).toContain("/Applications/Zen.app/Contents/MacOS/zen");
		expect(candidatesForChannel("firefox", { platform: "linux", home: "/home/test", pathEntries: ["/custom/bin"] })[0]).toBe("/custom/bin/firefox");
    expect(candidatesForChannel("firefox", { platform: "win32", home: "C:/Users/test", env: { ProgramFiles: "C:/Program Files" } })).toContain("C:/Program Files/Mozilla Firefox/firefox.exe");
	});


	test("auto picks the first installed channel and lists probes on failure", () => {
		expect(() => resolveBrowser("firefox", "auto", "", { platform: "darwin", exists: () => false })).toThrow("probed /Applications/Zen.app");
	});


	test("installs.ini wins over profiles.ini Default=1", () => {
		const profiles = `[Profile1]\nName=Empty\nIsRelative=1\nPath=Profiles/empty\nDefault=1\n[Profile0]\nName=Real\nIsRelative=1\nPath=Profiles/real\n`;
		const selected = selectFirefoxProfile("/root", profiles, `[InstallABC]\nDefault=Profiles/real\n`);
		expect(selected.name).toBe("Real");
		expect(selected.resolvedPath).toBe("/root/Profiles/real");
	});

	test("selects named relative profiles and refuses ambiguity", () => {
		const profiles = `[Profile0]\nName=One\nIsRelative=1\nPath=Profiles/one\n[Profile1]\nName=Two\nIsRelative=1\nPath=Profiles/two\n`;
		expect(selectFirefoxProfile("/root", profiles, "", "Two").resolvedPath).toBe("/root/Profiles/two");
		expect(() => selectFirefoxProfile("/root", profiles)).toThrow("available profiles: One");
		expect(parseProfilesIni(profiles)).toHaveLength(2);
	});

	test("missing profile returns the clean fallback warning", () => {
		const result = resolveSourceProfile("firefox", "zen", "", "", { platform: "darwin", home: "/missing", exists: () => false });
		expect(result.cleanFallback).toBe(true);
		expect(result.warnings[0]).toBe("headed-browser: no zen profile found; launched with an empty profile");
	});
});
