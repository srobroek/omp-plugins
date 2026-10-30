# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["trimesh==4.*", "numpy>=1.26"]
# ///
"""Write a GLB of two tetrahedra that each carry a collapsed triangle, then print `mesh.watertight`.

TST-0001 is closed; TST-0002 lacks one face. Each also carries the triangle BRepMesh emits at a
sphere pole: two corners at one position under different indices, so welding collapses it.
Usage: uv run --script mesh_probe.py DIR  (stdout: the watertight report as JSON)
"""

import json
import sys
from pathlib import Path

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from cadmodel import mesh  # noqa: E402

TETRA = np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [0.0, 0.01, 0.0], [0.0, 0.0, 0.01]])
FACES = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]


def with_pole(faces: list[list[int]]) -> trimesh.Trimesh:
    vertices = np.vstack([TETRA, TETRA[0]])  # vertex 4 duplicates vertex 0's position
    return trimesh.Trimesh(vertices=vertices, faces=[*faces, [0, 1, 4]], process=False)


scene = trimesh.Scene()
scene.add_geometry(with_pole(FACES), node_name="TST-0001 closed", geom_name="TST-0001 closed")
scene.add_geometry(with_pole(FACES[:3]), node_name="TST-0002 open", geom_name="TST-0002 open")
glb = Path(sys.argv[1]) / "probe.glb"
glb.write_bytes(scene.export(file_type="glb"))
print(json.dumps(mesh.watertight(glb, {"TST-0001": "TST-0001 closed", "TST-0002": "TST-0002 open"})))
