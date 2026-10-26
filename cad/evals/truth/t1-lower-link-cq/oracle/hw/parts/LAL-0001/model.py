# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["cadquery==2.8.*"]
# ///
"""LAL-0001 lamp arm lower link (oracle). Writes LAL-0001.step (AP242) beside this file."""

from pathlib import Path

import cadquery as cq
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_Controller

CENTRES = 120.0
WIDTH = 16.0
THICKNESS = 6.0
PIN_HOLE = 5.5


def build() -> cq.Workplane:
    return (
        cq.Workplane("XY")
        .slot2D(CENTRES + WIDTH, WIDTH)
        .extrude(THICKNESS)
        .faces(">Z")
        .workplane()
        .pushPoints([(-CENTRES / 2, 0), (CENTRES / 2, 0)])
        .hole(PIN_HOLE)
    )


if __name__ == "__main__":
    # The schema static exists only after the controller is initialised; set
    # earlier, it is silently ignored and the file is written as AP214.
    STEPControl_Controller.Init_s()
    if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
        raise SystemExit("could not select the AP242 STEP schema")
    cq.exporters.export(build(), str(Path(__file__).with_name("LAL-0001.step")), exportType="STEP")
