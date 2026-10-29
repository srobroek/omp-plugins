#!/usr/bin/env python3
"""Release approval order in the CAD Beads formulas: release.py seals hw/releases/<REV>/ for good,
so every formula step that runs it follows a human gate, and no gate waits on it."""

from __future__ import annotations

import tomllib
import unittest
from pathlib import Path

FORMULAS = Path(__file__).resolve().parents[3] / "formulas"
SEALS = "cad-record/scripts/release.py"


def ancestors(steps: dict[str, dict], step_id: str) -> set[str]:
    """Every step `step_id` needs, directly or through another step."""
    found: set[str] = set()
    pending = list(steps[step_id].get("needs", []))
    while pending:
        need = pending.pop()
        if need not in found:
            found.add(need)
            pending.extend(steps[need].get("needs", []))
    return found


class ReleaseApproval(unittest.TestCase):
    def test_every_release_follows_a_human_gate_and_no_gate_waits_on_one(self) -> None:
        sealing_formulas = 0
        for path in sorted(FORMULAS.glob("*.formula.toml")):
            steps = {step["id"]: step for step in tomllib.loads(path.read_text(encoding="utf-8"))["steps"]}
            gates = {step_id for step_id, step in steps.items() if step.get("gate", {}).get("type") == "human"}
            sealing = {step_id for step_id, step in steps.items() if SEALS in step.get("description", "")}
            sealing_formulas += bool(sealing)
            for step_id in sorted(sealing):
                with self.subTest(formula=path.name, step=step_id):
                    self.assertTrue(ancestors(steps, step_id) & gates, f"{step_id} seals a release before any gate")
            for gate in sorted(gates):
                with self.subTest(formula=path.name, gate=gate):
                    self.assertFalse(ancestors(steps, gate) & sealing, f"{gate} asks for approval after the release is sealed")
        self.assertEqual(sealing_formulas, 4, "cad-product, cad-part, cad-touch and mol-cad-release each run release.py")


if __name__ == "__main__":
    unittest.main()
