# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["cadquery==2.8.*"]
# ///
"""LBP-0001 lamp base plate (oracle).

Follows the cad-model part contract (KERNEL, PARAMS, build). Run directly, it also
writes LBP-0001.step (AP242) beside itself, the legacy deliverable path.
"""

from pathlib import Path

import cadquery as cq

KERNEL = "cadquery"
PARAMS = {"side": 80.0, "thickness": 5.0, "screw_pitch": 64.0, "screw_hole": 4.5, "cable_hole": 8.5}


def build(params: dict) -> cq.Workplane:
    return (
        cq.Workplane("XY")
        .box(params["side"], params["side"], params["thickness"], centered=(True, True, False))
        .faces(">Z")
        .workplane()
        .rect(params["screw_pitch"], params["screw_pitch"], forConstruction=True)
        .vertices()
        .hole(params["screw_hole"])
        .faces(">Z")
        .workplane()
        .hole(params["cable_hole"])
    )


if __name__ == "__main__":
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_Controller

    # The schema static exists only after the controller is initialised; set
    # earlier, it is silently ignored and the file is written as AP214.
    STEPControl_Controller.Init_s()
    if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
        raise SystemExit("could not select the AP242 STEP schema")
    cq.exporters.export(build(dict(PARAMS)), str(Path(__file__).with_name("LBP-0001.step")), exportType="STEP")
