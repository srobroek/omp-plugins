#!/usr/bin/env python3
"""Approval order in the CAD Beads formulas. release.py seals hw/releases/<REV>/ for good, so every formula step
that runs it follows a human gate, and no gate waits on it. Each stage that builds a version closes with a
provisional gate the lead resolves after the fast checks, a full check, and a human gate."""

from __future__ import annotations

import re
import tomllib
import unittest
from pathlib import Path

FORMULAS = Path(__file__).resolve().parents[3] / "formulas"
SEALS = "cad-record/scripts/release.py"
# The VOID instruction in each `<stage>-full-check` description: the `bd reopen` command, and the `bd dep tree`
# query that resolves its `<later closed steps>` placeholder.
REOPEN = re.compile(r"`bd reopen ([^`]*) --reason [^`]*`")
LATER = re.compile(
    r"where `<later closed steps>` are the ids `bd dep tree <([a-z0-9-]+)-step> --direction=up --status=closed --json` "
    r"lists, except steps labelled `([^`]+)` and bonded molecules"
)


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


def dep_tree_closed(steps: dict[str, dict], root: str, closed: set[str]) -> set[str]:
    """What `bd dep tree <root> --direction=up --status=closed` lists: `root` and the closed steps that need it,
    directly or through other closed steps (bonded molecules are not modelled)."""
    found: set[str] = set()
    pending = [root] if root in closed else []
    while pending:
        node = pending.pop()
        if node not in found:
            found.add(node)
            pending.extend(other for other, step in steps.items() if node in step.get("needs", []) and other in closed)
    return found


def void(steps: dict[str, dict], closed: set[str], full: str) -> set[str]:
    """`closed` after a VOID that runs exactly the `bd reopen` command the stage's full-check step `full` gives."""
    text = steps[full]["description"]
    (arguments,) = REOPEN.findall(text)
    reopened: set[str] = set()
    for placeholder in re.findall(r"<([^>]+)>", arguments):
        if placeholder == "later closed steps":
            ((root, label),) = LATER.findall(text)
            reopened |= {i for i in dep_tree_closed(steps, root, closed) if label not in steps[i].get("labels", [])}
            continue
        step_id = placeholder.removesuffix("-step")
        if not placeholder.endswith("-step") or step_id not in steps:
            raise AssertionError(f"{full} reopens {placeholder!r}, which names no step")
        reopened.add(step_id)
    return closed - reopened


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
                    voided = void(steps, closed, full)
                    self.assertEqual(ready(steps, voided) & {integrate, gate, full, target}, {integrate})

    def assert_human_gate_waits_for_a_new_full_check(self, steps: dict[str, dict], voided: set[str], gate: str) -> None:
        """After a VOID the fixed version passes the fast checks; the human gate still waits for a new full check."""
        integrate, full, human = self.stage(steps, gate)
        self.assertNotIn(human, ready(steps, voided))
        fixed = voided | {integrate, gate}
        self.assertIn(full, ready(steps, fixed))
        reviews = {i for i, s in steps.items() if "review" in s.get("labels", [])} & set(steps[human]["needs"])
        self.assertNotIn(human, ready(steps, fixed | reviews), "the human gate opened without a new full check")
        self.assertIn(human, ready(steps, fixed | reviews | {full}))

    def test_a_change_named_at_the_human_gate_after_the_full_check_closed_reopens_the_full_check(self) -> None:
        for name, stages in STAGES.items():
            steps = formula_steps(name)
            for gate, _, _ in stages:
                with self.subTest(formula=name, gate=gate):
                    _, full, human = self.stage(steps, gate)
                    closed = ancestors(steps, human)  # the full check passed; the user names a change at the gate
                    self.assertIn(human, ready(steps, closed))
                    self.assert_human_gate_waits_for_a_new_full_check(steps, void(steps, closed, full), gate)

    def test_a_late_major_review_reopens_the_full_check_and_both_reviews(self) -> None:
        for name in ("cad-product", "cad-part"):
            steps = formula_steps(name)
            with self.subTest(formula=name):
                integrate, full, human = self.stage(steps, "parts-provisional-gate")
                reviews = {"parts-mech-review", "parts-dfm-review"}
                self.assertLessEqual(reviews, set(steps[human]["needs"]))
                closed = ancestors(steps, human)  # full check closed, then a review returned MAJOR
                voided = void(steps, closed, full)
                self.assertFalse(reviews & voided, "a MAJOR review must run again on the fixed version")
                self.assert_human_gate_waits_for_a_new_full_check(steps, voided, "parts-provisional-gate")
                fixed = voided | {integrate, "parts-provisional-gate", full}
                self.assertNotIn(human, ready(steps, fixed), "the human gate opened before the reviews ran again")

    def test_a_void_reopens_a_later_stage_already_integrated_on_the_voided_version(self) -> None:
        for name, stages in STAGES.items():
            steps = formula_steps(name)
            for (gate, _, _), (next_gate, _, _) in zip(stages, stages[1:]):
                with self.subTest(formula=name, gate=gate):
                    integrate, full, human = self.stage(steps, gate)
                    next_integrate, next_full, next_human = self.stage(steps, next_gate)
                    # The later stage integrated and fully checked vN; this stage's full check passed and its gate is open.
                    closed = ancestors(steps, next_full) | {next_full} | ancestors(steps, human)
                    voided = void(steps, closed, full)
                    self.assertFalse({next_integrate, next_gate, next_full} & voided, "a later stage survived the VOID")
                    self.assertFalse(ready(steps, voided) & {next_integrate, next_gate, next_full, human, next_human})
                    self.assert_human_gate_waits_for_a_new_full_check(steps, voided, gate)
                    rebuilt = voided | {integrate, gate}
                    self.assertIn(next_integrate, ready(steps, rebuilt), "the later stage rebuilds on the fixed version")
                    rebuilt |= {next_integrate, next_gate}
                    self.assertIn(next_full, ready(steps, rebuilt))
                    approved = rebuilt | ancestors(steps, human) | {human} | (set(steps[next_human]["needs"]) - {next_full})
                    self.assertNotIn(next_human, ready(steps, approved), "a later human gate opened without its new full check")
                    self.assertIn(next_human, ready(steps, approved | {next_full}))


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
