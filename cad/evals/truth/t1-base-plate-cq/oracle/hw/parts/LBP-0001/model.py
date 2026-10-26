# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["cadquery==2.8.*"]
# ///
"""LBP-0001 lamp base plate (oracle). Writes LBP-0001.step (AP242) beside this file."""

from pathlib import Path

import cadquery as cq
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_Controller

SIDE = 80.0
THICKNESS = 5.0
SCREW_PITCH = 64.0
SCREW_HOLE = 4.5
CABLE_HOLE = 8.5


def build() -> cq.Workplane:
    return (
        cq.Workplane("XY")
        .box(SIDE, SIDE, THICKNESS, centered=(True, True, False))
        .faces(">Z")
        .workplane()
        .rect(SCREW_PITCH, SCREW_PITCH, forConstruction=True)
        .vertices()
        .hole(SCREW_HOLE)
        .faces(">Z")
        .workplane()
        .hole(CABLE_HOLE)
    )


if __name__ == "__main__":
    # The schema static exists only after the controller is initialised; set
    # earlier, it is silently ignored and the file is written as AP214.
    STEPControl_Controller.Init_s()
    if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
        raise SystemExit("could not select the AP242 STEP schema")
    cq.exporters.export(build(), str(Path(__file__).with_name("LBP-0001.step")), exportType="STEP")
