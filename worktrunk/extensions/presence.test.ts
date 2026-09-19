import { describe, expect, test } from "bun:test";

import pkg from "../package.json" with { type: "json" };
import "./worktree-gate.ts";

describe("worktrunk presence", () => {
	test("publishes the package version when the first extension loads", () => {
		expect((globalThis as Record<symbol, unknown>)[Symbol.for("com.srobroek.worktrunk.present.v1")]).toEqual({ version: pkg.version });
	});
});
