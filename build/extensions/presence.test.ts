import { describe, expect, test } from "bun:test";

import "./presence.ts";

describe("build presence", () => {
	test("publishes the package version when the extension loads", () => {
		expect((globalThis as Record<symbol, unknown>)[Symbol.for("com.srobroek.build.present.v1")]).toEqual({ version: "0.6.1" });
	});
});
