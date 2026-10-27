# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Write cad-motion test geometry as STEP AP242, modeled in place at the zero pose.

Usage: uv run --script build_fixtures.py OUT_DIR

OUT_DIR/lamp/       LMP-0001..LMP-0013 as one STEP per part, plus
                    lamp-arm.step (one assembly STEP of the same parts). The
                    geometry is a stand-in for the cad-record lamp-arm template,
                    whose model.py files are placeholders; it follows the
                    template's assembly.yaml joint origins and axes: the arm lies
                    straight along +X at the zero pose.
OUT_DIR/planar/     TST-0001..TST-0003, a planar three-link arm in two Z layers:
                    TST-0001 (ground, layer 0) x 0..100, TST-0002 (layer 1)
                    x 100..200, TST-0003 (layer 0) x 200..350. Folding TST-0003
                    back by 180 degrees about (200, 0) overlaps TST-0001 in
                    x 50..100: 50 x 10 x 10 = 5000 mm^3.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

POSE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "pose.py"
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)

LAMP_TITLES = {
    "LMP-0001": "Base plate and pivot boss",
    "LMP-0002": "Lower link",
    "LMP-0003": "Upper link",
    "LMP-0004": "Lamp head housing",
    "LMP-0005": "M5 x 30 shoulder pin",
    "LMP-0006": "M5 x 25 shoulder pin",
    "LMP-0007": "M5 x 20 shoulder pin",
    "LMP-0008": "Bushing SPIROL CMPL 4 X 8 EK CL8000",
    "LMP-0009": "Bushing SPIROL CMPL 4 X 6 EK CL8100",
    "LMP-0010": "Heat-set insert QT M10x1 x 12.7 OD 12.6",
    "LMP-0011": "Retaining ring DIN 471 - 5x0.6",
    "LMP-0012": "Retaining ring DIN 471 - 5x0.6",
    "LMP-0013": "Retaining ring DIN 471 - 5x0.6",
}
PIN_R, BORE_R, LUG_R = 2.5, 2.6, 6.0  # M5 shank in a 5.2 mm bore: 0.1 mm radial clearance


def box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt

    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape()


def cylinder(base: tuple[float, float, float], direction: tuple[float, float, float], radius: float, height: float):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(*base), gp_Dir(*direction)), radius, height).Shape()


def fuse(*shapes):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse

    result = shapes[0]
    for shape in shapes[1:]:
        result = BRepAlgoAPI_Fuse(result, shape).Shape()
    return result


def cut(shape, *tools):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut

    for tool in tools:
        shape = BRepAlgoAPI_Cut(shape, tool).Shape()
    return shape


def tube(base: tuple[float, float, float], direction: tuple[float, float, float], outer: float, inner: float, height: float):
    return cut(cylinder(base, direction, outer, height), cylinder(base, direction, inner, height))


Y, Z = (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)


def lamp_shapes() -> dict[str, object]:
    """Joint origins: J-001 (0,0,40) axis Z; J-002 (160,0,40) axis Y; J-003 (360,0,40) axis Y."""
    base = cut(
        fuse(box(-80, -80, 0, 80, 80, 8), cylinder((0, 0, 8), Z, 16, 25)),
        cylinder((0, 0, -1), Z, BORE_R, 35),
        cylinder((-55, 0, -1), Z, 3.3, 10), cylinder((55, 0, -1), Z, 3.3, 10),  # two M6 clearance holes
    )
    lower = cut(
        fuse(cylinder((0, 0, 34), Z, 14, 12), box(0, 2, 34, 160, 10, 46), cylinder((160, 2, 40), Y, LUG_R, 8)),
        cylinder((0, 0, 30), Z, BORE_R, 20), cylinder((160, 0, 40), Y, BORE_R, 12),
    )
    upper = cut(
        fuse(box(160, -10, 34, 360, -2, 46), cylinder((160, -10, 40), Y, LUG_R, 8), cylinder((360, -10, 40), Y, LUG_R, 8)),
        cylinder((160, -12, 40), Y, BORE_R, 12), cylinder((360, -12, 40), Y, BORE_R, 12),
    )
    head = cut(
        fuse(box(360, 2, 34, 400, 10, 46), cylinder((360, 2, 40), Y, LUG_R, 8), cylinder((420, 0, 10), Z, 30, 30)),
        cylinder((360, 0, 40), Y, BORE_R, 12), cylinder((430, 0, 30), Z, 6.0, 10),  # pin bore, insert hole
    )
    return {
        "LMP-0001": base,
        "LMP-0002": lower,
        "LMP-0003": upper,
        "LMP-0004": head,
        # Shoulder pins: shank through both bores, head 0.5 mm off the outer face.
        "LMP-0005": fuse(cylinder((0, 0, 16), Z, PIN_R, 30), cylinder((0, 0, 46.5), Z, 4, 3)),
        "LMP-0006": fuse(cylinder((160, -12.5, 40), Y, PIN_R, 25), cylinder((160, 10.5, 40), Y, 4, 3)),
        "LMP-0007": fuse(cylinder((360, -9.5, 40), Y, PIN_R, 20), cylinder((360, -13.5, 40), Y, 4, 3)),
        # Bushings, insert and rings: tubes on the template's J-007..J-012 axes.
        "LMP-0008": tube((0, 0, 21.5), Z, 4.0, BORE_R, 8),
        "LMP-0009": tube((360, 2, 40), Y, 4.0, BORE_R, 7),
        "LMP-0010": tube((430, 0, 30), Z, 6.3, 4.5, 10),
        "LMP-0011": tube((0, 0, 16.5), Z, 3.2, PIN_R, 0.6),
        "LMP-0012": tube((160, -12, 40), Y, 3.2, PIN_R, 0.6),
        "LMP-0013": tube((360, 9, 40), Y, 3.2, PIN_R, 0.6),
    }


def planar_shapes() -> dict[str, object]:
    return {
        "TST-0001": box(0, -5, 0, 100, 5, 10),
        "TST-0002": box(100, -5, 10, 200, 5, 20),
        "TST-0003": box(200, -5, 0, 350, 5, 10),
    }


def write_set(folder: Path, shapes: dict[str, object], titles: dict[str, str], top: str | None) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    identity = pose.Rigid.identity()
    parts = [pose.Part(pn, f"{pn} {titles[pn]}", shape) for pn, shape in shapes.items()]
    for part in parts:
        pose.write_step(folder / f"{part.pn}.step", None, [(part, identity)])
    if top:
        pose.write_step(folder / f"{top}.step", top, [(part, identity) for part in parts])


def main(out: Path) -> int:
    write_set(out / "lamp", lamp_shapes(), LAMP_TITLES, "lamp-arm")
    write_set(out / "planar", planar_shapes(), {"TST-0001": "Ground link", "TST-0002": "Middle link", "TST-0003": "Tip link"}, None)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
