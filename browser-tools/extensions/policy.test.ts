import { describe, expect, test } from "bun:test";
import type { Cookie } from "puppeteer-core";
import type { EffectiveConfig } from "./lib/config.ts";
import { checkNavigation, deriveDomainPolicy, redact, requireFeature, visibleCookies } from "./lib/policy.ts";

const baseConfig = {
	allowedDomains: "",
	deniedDomains: "",
	allowDownloads: true,
	allowFormSubmit: true,
	allowPasswordEntry: true,
	allowFileUpload: true,
	allowEvaluate: true,
} as EffectiveConfig;

describe("headed browser privacy policy", () => {
	test("rejects non-http schemes", () => {
		expect(() => checkNavigation("file:///etc/hosts", deriveDomainPolicy(baseConfig))).toThrow("headed-browser: scheme file is not navigable");
	});

	test("derives allowlist mode and matches subdomains", () => {
		const policy = deriveDomainPolicy({ allowedDomains: "example.com", deniedDomains: "" });
		expect(policy.mode).toBe("allowlist");
		expect(checkNavigation("https://a.example.com/path", policy).hostname).toBe("a.example.com");
		expect(() => checkNavigation("https://other.test", policy)).toThrow("blocked by allowedDomains");
	});

	test("derives denylist mode", () => {
		const policy = deriveDomainPolicy({ allowedDomains: "", deniedDomains: "example.com" });
		expect(policy.mode).toBe("denylist");
		expect(() => checkNavigation("https://a.example.com", policy)).toThrow("blocked by deniedDomains");
		expect(checkNavigation("https://other.test", policy).hostname).toBe("other.test");
	});

	test("allows unrestricted HTTP navigation when both lists are empty", () => {
		const policy = deriveDomainPolicy({ allowedDomains: "", deniedDomains: "" });
		expect(policy.mode).toBe("none");
		expect(checkNavigation("https://example.com", policy).hostname).toBe("example.com");
	});

	test("refuses simultaneous allow and deny lists", () => {
		expect(() => deriveDomainPolicy({ allowedDomains: "a.com", deniedDomains: "b.com" })).toThrow("headed-browser: allowedDomains and deniedDomains are mutually exclusive; clear one");
	});

	test("feature gates name the setting that enables them", () => {
		for (const feature of ["Downloads", "FormSubmit", "PasswordEntry", "FileUpload", "Evaluate"] as const) {
			const config = { ...baseConfig, [`allow${feature}`]: false } as EffectiveConfig;
			expect(() => requireFeature(config, feature)).toThrow(`set allow${feature}=true`);
		}
	});

	test("redacts headers, JWTs, API tokens, and password values", () => {
		const jwt = "eyABCDEFGHIJK.abcdefghijklmnop.qrstuvwxyzABCDE";
		const text = `Cookie: secret=1\nAuthorization: Bearer abc\n${jwt}\nsk-abcdefghijklmnopqr\n<input type=\"password\" value=\"secret\">`;
		const output = redact(text, { redactSecrets: true });
		expect(output).not.toContain("secret=1");
		expect(output).not.toContain("Bearer abc");
		expect(output).not.toContain(jwt);
		expect(output).not.toContain("sk-abcdefghijklmnopqr");
		expect(output).not.toContain('value="secret"');
	});

	test("cookie listings hide values unless explicitly enabled", () => {
		const cookies = [{ name: "sid", value: "secret", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }] as Cookie[];
		expect(visibleCookies(cookies, { exposeCookieValues: false })[0]).not.toHaveProperty("value");
		expect(visibleCookies(cookies, { exposeCookieValues: true })[0]?.value).toBe("secret");
	});
});
