# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Write cad-motion test geometry as STEP AP242.

Usage: uv run --script build_fixtures.py OUT_DIR

OUT_DIR/lamp/       LMP-0001..LMP-0011 as one STEP per part definition, plus
                    lamp-arm.step (one assembly STEP placing every occurrence of
                    cad/examples/lamp-arm/hw/assembly.yaml: each part once, the
                    LMP-0011 ring three times. The geometry is a stand-in for the
                    example's models; it follows the example's joint origins and
                    axes: the arm lies straight along +X at the zero pose. LMP-0011
                    is part-local (axis +Z, one face on z 0); every other part is
                    modeled in place.
OUT_DIR/twins/      TST-0201, a ground plate z -5..0 over x -20..80, y -20..60,
                    and TST-0202, a part-local arm box x 0..50, y -5..5, z 0..5
                    with a 5 x 5 x 5 tab at x 0..5, y 5..10 (asymmetric: a
                    mirrored or misrotated placement moves the tab).
OUT_DIR/v6/         VSX-0001..VSX-0401, the coupled V6-like mechanism of
                    v6_record.py: a block plate below the crank; the crankshaft
                    (three main-journal boxes clear of the rods and one 3 mm
                    crankpin box per cylinder at its crank-angle-0 position);
                    and the part-local piston, rod, camshaft and valve boxes
                    v6_record.py describes.
OUT_DIR/nest/       A 2 mm cube TST-0302 (x, y, z 4..6) buried in a 10 mm
                    container TST-0301 (0..10), no faces touching. In solid/
                    the container is the cube, a SOLID; in compound/ it is the
                    cube plus a 1 mm cube at x 20..21, which reads back as a
                    COMPOUND of two solids.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

POSE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "pose.py"
TEMPLATE_HW = Path(__file__).resolve().parents[4] / "examples" / "lamp-arm" / "hw"
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import v6_record  # noqa: E402 - the kernel-free record beside this script

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
        # Bushings and insert: tubes on the template's J-007..J-009 axes.
        "LMP-0008": tube((0, 0, 21.5), Z, 4.0, BORE_R, 8),
        "LMP-0009": tube((360, 2, 40), Y, 4.0, BORE_R, 7),
        "LMP-0010": tube((430, 0, 30), Z, 6.3, 4.5, 10),
        # The ring definition, part-local; the template's occurrences place it on the three pins.
        "LMP-0011": tube((0, 0, 0), Z, 3.2, PIN_R, 0.6),
    }


def planar_shapes() -> dict[str, object]:
    return {
        "TST-0001": box(0, -5, 0, 100, 5, 10),
        "TST-0002": box(100, -5, 10, 200, 5, 20),
        "TST-0003": box(200, -5, 0, 350, 5, 10),
    }


def twin_shapes() -> dict[str, object]:
    return {
        "TST-0201": box(-20, -20, -5, 80, 60, 0),
        "TST-0202": fuse(box(0, -5, 0, 50, 5, 5), box(0, 5, 0, 5, 10, 5)),
    }


def v6_shapes() -> dict[str, object]:
    pins = [box(x - 1.5, y - 1.5, z - 1.5, x + 1.5, y + 1.5, z + 1.5)
            for x, y, z in (v6_record.crankpin_rest(x, side, phase) for _, x, side, phase in v6_record.CYLINDERS)]
    journals = [box(-55, -3, -3, -48, 3, 3), box(-2, -3, -3, 2, 3, 3), box(48, -3, -3, 55, 3, 3)]
    return {
        "VSX-0001": box(-55, -20, -45, 55, 20, -40),
        "VSX-0101": fuse(*journals, *pins),
        "VSX-0201": box(-4, -4, -4, 4, 4, 2),
        "VSX-0211": box(-1, -1, -v6_record.L + 3, 1, 1, -5),
        "VSX-0301": box(-48, -2, -2, 48, 2, 2),
        "VSX-0401": box(-1.5, -1.5, 2 + v6_record.VALVE_GAP, 1.5, 1.5, 5 + v6_record.VALVE_GAP),
    }


def compound(*shapes):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    result, builder = TopoDS_Compound(), BRep_Builder()
    builder.MakeCompound(result)
    for shape in shapes:
        builder.Add(result, shape)
    return result


def nest_shapes(container_kind: str) -> dict[str, object]:
    container = box(0, 0, 0, 10, 10, 10)
    return {
        "TST-0301": compound(container, box(20, 0, 0, 21, 1, 1)) if container_kind == "compound" else container,
        "TST-0302": box(4, 4, 4, 6, 6, 6),
    }


def write_set(folder: Path, shapes: dict[str, object], titles: dict[str, str]) -> dict[str, object]:
    folder.mkdir(parents=True, exist_ok=True)
    parts = {pn: pose.Part(pn, f"{pn} {titles[pn]}", shape) for pn, shape in shapes.items()}
    for part in parts.values():
        pose.write_part_step(folder / f"{part.pn}.step", part)
    return parts


def main(out: Path) -> int:
    lamp = write_set(out / "lamp", lamp_shapes(), LAMP_TITLES)
    assembly = pose.load_assembly(TEMPLATE_HW)
    rests = {o.id: pose.Rigid.from_placement(o.placement) for o in assembly.occurrences}
    pose.write_assembly_step(out / "lamp" / "lamp-arm.step", "lamp-arm", lamp, assembly.occurrences, rests)
    write_set(out / "planar", planar_shapes(), {"TST-0001": "Ground link", "TST-0002": "Middle link", "TST-0003": "Tip link"})
    write_set(out / "twins", twin_shapes(), {"TST-0201": "Ground plate", "TST-0202": "Arm"})
    write_set(out / "v6", v6_shapes(), {pn: title for pn, (title, _) in v6_record.PARTS.items()})
    for kind in ("solid", "compound"):
        write_set(out / "nest" / kind, nest_shapes(kind), {"TST-0301": f"Container ({kind})", "TST-0302": "Buried cube"})
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
