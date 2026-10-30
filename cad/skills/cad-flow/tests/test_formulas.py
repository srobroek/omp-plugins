#!/usr/bin/env python3
"""Approval order in the CAD Beads formulas. release.py seals hw/releases/<REV>/ for good, so every formula step
that runs it follows a human gate, and no gate waits on it. Each stage that builds a version closes with a
provisional gate the lead resolves after the fast checks, a full check, and a human gate."""

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


def formula_steps(name: str) -> dict[str, dict]:
    return {step["id"]: step for step in tomllib.loads((FORMULAS / f"{name}.formula.toml").read_text(encoding="utf-8"))["steps"]}


def ready(steps: dict[str, dict], closed: set[str]) -> set[str]:
    """Steps Beads offers once `closed` are closed: open, with every direct need closed (gates not modelled)."""
    return {step_id for step_id, step in steps.items() if step_id not in closed and set(step.get("needs", [])) <= closed}


# Per root, each built stage in order: (provisional gate, the next stage's first step, the next integration step).
STAGES: dict[str, list[tuple[str, str | None, str | None]]] = {
    "cad-product": [
        ("layout-provisional-gate", "parts-fanout", "parts-integrate"),
        ("parts-provisional-gate", "detail-fanout", "detail-integrate"),
        ("detail-provisional-gate", "bom", "analysis-integrate"),
        ("analysis-provisional-gate", "mech-critique", "reconcile"),
    ],
    "cad-touch": [
        ("revision-provisional-gate", "analysis-fanout", "analysis-integrate"),
        ("analysis-provisional-gate", "mech-critique", "reconcile"),
    ],
    "mol-cad-iterate": [
        ("detail-provisional-gate", "analysis-fanout", "analysis-integrate"),
        ("analysis-provisional-gate", None, None),
    ],
}
STAGES["cad-part"] = STAGES["cad-product"]
FREEZES = ("design-freeze-gate", "release-gate", "release-package")


class StageGates(unittest.TestCase):
    def stage(self, steps: dict[str, dict], provisional: str) -> tuple[str, str, str]:
        """The stage's integration step, full check, and human gate around `provisional`."""
        (integrate,) = steps[provisional]["needs"]
        (full,) = [i for i, s in steps.items() if provisional in s.get("needs", []) and "full-check" in s.get("labels", [])]
        (human,) = [i for i, s in steps.items() if full in s.get("needs", []) and s.get("gate", {}).get("type") == "human"]
        return integrate, full, human

    def test_each_built_stage_runs_a_provisional_gate_then_its_full_check_then_its_human_gate(self) -> None:
        for name, stages in STAGES.items():
            steps = formula_steps(name)
            provisional = {i for i, s in steps.items() if "provisional" in s.get("labels", [])}
            self.assertEqual(provisional, {stage[0] for stage in stages}, name)
            previous_human = None
            for gate, _, _ in stages:
                with self.subTest(formula=name, gate=gate):
                    self.assertNotIn("gate", steps[gate], "the lead closes a provisional gate; it is no Beads gate")
                    self.assertIn("phase:gate", steps[gate]["labels"])
                    integrate, full, human = self.stage(steps, gate)
                    closed = ancestors(steps, gate) | {gate}
                    self.assertIn(full, ready(steps, closed), "the full check starts on the provisional gate")
                    self.assertNotIn(human, ready(steps, closed), "the human gate opens only after the full check")
                    if previous_human:
                        self.assertIn(previous_human, ancestors(steps, human), "human gates approve stages in order")
                    previous_human = human

    def test_the_next_stage_starts_on_the_provisional_gate_but_nothing_freezes_before_the_human_gate(self) -> None:
        for name, stages in STAGES.items():
            steps = formula_steps(name)
            humans = {self.stage(steps, gate)[2] for gate, _, _ in stages}
            for gate, start, _ in stages:
                if start is None:
                    continue
                with self.subTest(formula=name, gate=gate):
                    human = self.stage(steps, gate)[2]
                    self.assertIn(start, ready(steps, ancestors(steps, gate) | {gate}))
                    self.assertNotIn(human, ancestors(steps, start))
            for freeze in (f for f in FREEZES if f in steps):
                with self.subTest(formula=name, freezes=freeze):
                    earlier = humans - {freeze}  # mol-cad-iterate's DESIGN freeze gate is its analysis stage's human gate
                    self.assertLessEqual(earlier, ancestors(steps, freeze), f"{freeze} can run before a stage's human gate")

    def test_a_void_reopen_blocks_the_full_check_and_the_next_integration_until_a_fixed_version_passes(self) -> None:
        for name, stages in STAGES.items():
            steps = formula_steps(name)
            for gate, _, next_integrate in stages:
                with self.subTest(formula=name, gate=gate):
                    integrate, full, _ = self.stage(steps, gate)
                    target = next_integrate or full
                    closed = ancestors(steps, target)
                    self.assertIn(target, ready(steps, closed))
                    voided = closed - {integrate, gate}
                    self.assertEqual(ready(steps, voided) & {integrate, gate, full, target}, {integrate})


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
