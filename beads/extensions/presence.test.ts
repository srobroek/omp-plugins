import { describe, expect, test } from "bun:test";

import "./formula-check-tool.ts";

describe("beads presence", () => {
	test("publishes the package version when the first extension loads", () => {
		expect((globalThis as Record<symbol, unknown>)[Symbol.for("com.srobroek.beads.present.v1")]).toEqual({ version: "2.0.2" });
	});
});
