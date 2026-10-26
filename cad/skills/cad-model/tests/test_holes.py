#!/usr/bin/env python3
"""Hole recognition on fixture parts built by `cad_model.py run` in both kernels.

Each case in CASES is one part built from tests/fixtures/<kernel>/hole_case.py. Its `holes` in
metrics.json must equal the listed holes exactly, in both kernels. cad-design's form check runs on
the same parts to show that bores stay out of its CNC corner-radius rule.

Run: python3 -m unittest discover -s cad/skills/cad-model/tests -p test_holes.py -v
Needs `uv`; the first run creates the uv environments (see test_cad_model.py).
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
CLI = HERE.parent / "scripts" / "cad_model.py"
FORM_CHECK = HERE.parents[1] / "cad-design" / "scripts" / "form_check.py"
KERNELS = ("cadquery", "build123d")
DOWN = [0.0, 0.0, -1.0]


def hole(n: int, diameter: float, axis: list[float], position: list[float], depth: float, through: bool) -> dict:
    return {"id": f"H{n}", "diameter_mm": diameter, "axis": axis, "position": position, "depth_mm": depth,
            "through": through}


# Case -> its exact metrics.json `holes`. Geometry in the fixture's docstring and build().
CASES: dict[str, list[dict]] = {
    # Ø4 x 5 blind from the bottom and from the top, 10 mm of material between them.
    "opposed_blind": [hole(1, 4.0, [0.0, 0.0, 1.0], [20.0, 15.0, 0.0], 5.0, False),
                      hole(2, 4.0, DOWN, [20.0, 15.0, 20.0], 5.0, False)],
    # Ø4 along x on (y 15, z 12) across a 10 mm slot from the top: one bore, the slot gap included.
    "clevis": [hole(1, 4.0, [-1.0, 0.0, 0.0], [40.0, 15.0, 12.0], 40.0, True)],
    # Ø6 half-round channel along the top edge, cut as two 20 mm pieces end to end.
    "split_channel": [],
    # Ø1.6 through, cut as two half-bores side by side.
    "seam_split": [hole(1, 1.6, DOWN, [20.0, 15.0, 20.0], 20.0, True)],
    # Ø4 through whose top widens: 3 mm at 15 degrees, 2 mm at 3 degrees, an r1 round.
    "lead_in_15": [hole(1, 4.0, DOWN, [20.0, 15.0, 17.0], 17.0, True)],
    "lead_in_3": [hole(1, 4.0, DOWN, [20.0, 15.0, 18.0], 18.0, True)],
    "rounded_mouth": [hole(1, 4.0, DOWN, [20.0, 15.0, 19.0], 19.0, True)],
    # Ø4 x 8 blind ending in a 118 degree drill point, a ball; Ø6 x 8 with an r1 corner at its floor.
    "drill_point": [hole(1, 4.0, DOWN, [20.0, 15.0, 20.0], 8.0, False)],
    "ball_end": [hole(1, 4.0, DOWN, [20.0, 15.0, 20.0], 8.0, False)],
    "corner_radius": [hole(1, 6.0, DOWN, [20.0, 15.0, 20.0], 7.0, False)],
    # Ø5 through with a Ø9 x 3 counterbore from the top.
    "counterbore": [hole(1, 5.0, DOWN, [20.0, 15.0, 17.0], 17.0, True),
                    hole(2, 9.0, DOWN, [20.0, 15.0, 20.0], 3.0, False)],
}
PNS = {case: f"HOL-{i:04d}" for i, case in enumerate(CASES, start=1)}


def hole_project(root: Path, kernel: str) -> Path:
    """An hw/ record with one cnc part per case, all fixed to the first."""
    hw = root / kernel / "hw"
    hw.mkdir(parents=True)
    (hw / "product.yaml").write_text("id: holes\n", encoding="utf-8")
    first, *rest = PNS.values()
    (hw / "assembly.yaml").write_text("joints:\n" + "".join(
        f"  - {{id: J-{i:03d}, type: fixed, parent: {first}, child: {pn}, axis: [0, 0, 1], origin: [0, 0, 0],"
        f" min: 0, max: 0, nominal: 0}}\n" for i, pn in enumerate(rest, start=1)), encoding="utf-8")
    source = (FIXTURES / kernel / "hole_case.py").read_text(encoding="utf-8")
    for case, pn in PNS.items():
        folder = hw / "parts" / pn
        folder.mkdir(parents=True)
        model = re.sub(r"^PARAMS = .*$", f"PARAMS = {{'case': {case!r}}}", source, count=1, flags=re.M)
        (folder / "model.py").write_text(model, encoding="utf-8")
        (folder / "part.yaml").write_text(
            f"PN: {pn}\nrev: X1\ntitle: Hole case {case}\nmaterial: Aluminum 6061-T6\nprocess: cnc\n"
            f"finish: none\nmass_target: 100\nmake_buy: make\nsupplier: null\n", encoding="utf-8")
    return hw


def uv_script(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["uv", "run", "--quiet", "--script", str(script), *args],
                          capture_output=True, text=True, check=False)  # no timeout: cold OCP imports take minutes


def build(root: Path, kernel: str) -> tuple[Path, subprocess.CompletedProcess[str]]:
    hw = hole_project(root, kernel)
    return hw, uv_script(CLI, "run", str(hw), "--label", "v1")


@unittest.skipUnless(shutil.which("uv"), "uv is required for the kernel environments")
class HoleCaseTests(unittest.TestCase):
    """Every case lists exactly its expected holes, in both kernels."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        root = Path(cls._tmp.name)
        with ThreadPoolExecutor(max_workers=len(KERNELS)) as pool:
            built = dict(zip(KERNELS, pool.map(lambda kernel: build(root, kernel), KERNELS)))
        cls.hw = {kernel: hw for kernel, (hw, _) in built.items()}
        cls.runs = {kernel: proc for kernel, (_, proc) in built.items()}

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def metrics(self, kernel: str) -> dict:
        proc = self.runs[kernel]
        self.assertEqual(proc.returncode, 0, f"{kernel} run: {proc.stdout[-3000:]}{proc.stderr[-2000:]}")
        return json.loads((self.hw[kernel] / "versions" / "v1" / "metrics.json").read_text(encoding="utf-8"))["parts"]

    def assert_holes(self, *cases: str) -> None:
        for kernel in KERNELS:
            parts = self.metrics(kernel)
            for case in cases:
                with self.subTest(kernel=kernel, case=case):
                    self.assertEqual(parts[PNS[case]]["holes"], CASES[case])

    def test_two_blind_holes_on_one_axis_stay_two_blind_holes(self) -> None:
        self.assert_holes("opposed_blind")

    def test_a_bore_across_a_clevis_slot_stays_one_through_bore(self) -> None:
        self.assert_holes("clevis")

    def test_a_split_channel_is_no_hole_while_a_seam_split_bore_is_one(self) -> None:
        self.assert_holes("split_channel", "seam_split")

    def test_a_lead_in_of_any_angle_or_a_round_opens_the_end(self) -> None:
        self.assert_holes("lead_in_15", "lead_in_3", "rounded_mouth")

    def test_a_drill_point_ball_end_or_corner_radius_closes_the_end(self) -> None:
        self.assert_holes("drill_point", "ball_end", "corner_radius")

    def test_each_counterbore_step_is_its_own_bore(self) -> None:
        self.assert_holes("counterbore")

    def test_form_check_corner_radius_rule_skips_bores_and_keeps_partial_walls(self) -> None:
        """The seam-split Ø1.6 bore is no internal corner; the split channel's r3 walls are."""
        for kernel in KERNELS:
            self.metrics(kernel)
            hw = self.hw[kernel]
            with self.subTest(kernel=kernel):
                proc = uv_script(FORM_CHECK, "--hw", str(hw), "--parts-dir", str(hw / "versions" / "v1" / "parts"),
                                 "--fidelity", "F2", "--cnc-tool-radius", "4")
                self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
                corners = [f for f in json.loads(proc.stdout)["findings"] if f["check"] == "cnc_internal_radius"]
                self.assertEqual(corners, [{"check": "cnc_internal_radius", "part": PNS["split_channel"],
                                            "radius": 3.0, "min": 4.0}])


if __name__ == "__main__":
    unittest.main()
