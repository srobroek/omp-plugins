# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["cadquery==2.8.*"]
# ///
"""LAL-0001 lamp arm lower link (oracle).

Follows the cad-model part contract (KERNEL, PARAMS, build). Run directly, it also
writes LAL-0001.step (AP242) beside itself, the legacy deliverable path.
"""

from pathlib import Path

import cadquery as cq

KERNEL = "cadquery"
PARAMS = {"centres": 120.0, "width": 16.0, "thickness": 6.0, "pin_hole": 5.5}


def build(params: dict) -> cq.Workplane:
    return (
        cq.Workplane("XY")
        .slot2D(params["centres"] + params["width"], params["width"])
        .extrude(params["thickness"])
        .faces(">Z")
        .workplane()
        .pushPoints([(-params["centres"] / 2, 0), (params["centres"] / 2, 0)])
        .hole(params["pin_hole"])
    )


if __name__ == "__main__":
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_Controller

    # The schema static exists only after the controller is initialised; set
    # earlier, it is silently ignored and the file is written as AP214.
    STEPControl_Controller.Init_s()
    if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
        raise SystemExit("could not select the AP242 STEP schema")
    cq.exporters.export(build(dict(PARAMS)), str(Path(__file__).with_name("LAL-0001.step")), exportType="STEP")
