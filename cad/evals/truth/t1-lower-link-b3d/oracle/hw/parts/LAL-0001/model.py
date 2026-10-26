# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["build123d==0.13.*"]
# ///
"""LAL-0001 lamp arm lower link (oracle).

Follows the cad-model part contract (KERNEL, PARAMS, build). Run directly, it also
writes LAL-0001.step (AP242) beside itself, the legacy deliverable path.
"""

from pathlib import Path

from build123d import BuildPart, BuildSketch, Circle, Locations, Mode, SlotCenterToCenter, extrude

KERNEL = "build123d"
PARAMS = {"centres": 120.0, "width": 16.0, "thickness": 6.0, "pin_hole": 5.5}


def build(params: dict):
    with BuildPart() as link:
        with BuildSketch():
            SlotCenterToCenter(params["centres"], params["width"])
            with Locations((-params["centres"] / 2, 0), (params["centres"] / 2, 0)):
                Circle(params["pin_hole"] / 2, mode=Mode.SUBTRACT)
        extrude(amount=params["thickness"])
    return link.part


def export_ap242(shape, path: Path) -> None:
    """build123d 0.13's export_step always writes AP214 (its XDE writer builds the
    model before the schema static is read), so write through STEPControl_Writer."""
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Controller, STEPControl_Writer

    STEPControl_Controller.Init_s()
    if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
        raise SystemExit("could not select the AP242 STEP schema")
    writer = STEPControl_Writer()
    writer.Transfer(shape.wrapped, STEPControl_AsIs)
    if writer.Write(str(path)) != IFSelect_RetDone:
        raise SystemExit(f"STEP write failed: {path}")


if __name__ == "__main__":
    export_ap242(build(dict(PARAMS)), Path(__file__).with_name("LAL-0001.step"))
