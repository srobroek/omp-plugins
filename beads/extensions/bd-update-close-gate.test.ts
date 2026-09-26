import { describe, expect, test } from "bun:test";
import { decideBdUpdateClose, UPDATE_CLOSE_REASON } from "./bd-update-close-gate.ts";

describe("bd update close-status gate", () => {
	test("refuses every status spelling and shell routing form", () => {
		for (const status of ["closed", "done"]) {
			for (const flag of ["--status", "-s"]) {
				for (const value of [`${flag} ${status}`, `${flag}=${status}`]) {
					for (const command of [
						`bd update bead-1 ${value}`,
						`bd -C /repo update bead-1 ${value}`,
						`BEADS_DIR=/repo/.beads bd update bead-1 ${value}`,
						`cd /repo && bd update bead-1 ${value}`,
						`'/opt/bun' '/opt/beads/extensions/bd-embedded-write-runner.js' --beads-store '/repo/.beads' --beads-wait-ms 120000 -- bd update bead-1 ${value}`,
					]) {
						expect(decideBdUpdateClose(command)).toEqual({ block: true, reason: UPDATE_CLOSE_REASON });
					}
				}
			}
		}
	});

	test("allows non-closing status updates and other update fields", () => {
		for (const command of [
			"bd update bead-1 --status open",
			"bd update bead-1 --status in_progress",
			"bd update bead-1 --status blocked",
			"bd update bead-1 --status deferred",
			"bd update bead-1 -s=open",
			"bd update bead-1 --title 'done later'",
		]) expect(decideBdUpdateClose(command)).toBeUndefined();
	});

	test("allows the reason-bearing close command", () => {
		expect(decideBdUpdateClose('bd close bead-1 --reason "implemented and reviewed"')).toBeUndefined();
	});
});
