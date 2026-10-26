"""Binary glTF from the assembly STEP, the PN -> mesh-node map, and mesh watertightness."""

from __future__ import annotations

import json
import math
import re
import struct
from pathlib import Path
from typing import Any, Iterable

from cadmodel import occ

PN_PREFIX = re.compile(r"^([A-Z]{2,5}-\d{4})(?![0-9])")
# Tessellation: chord deviation relative to the assembly diagonal, clamped; angular deflection in rad.
LINEAR_RELATIVE, LINEAR_MIN_MM, LINEAR_MAX_MM, ANGULAR_RAD = 5e-4, 0.01, 0.2, 0.25


def deflection(shape: Any) -> float:
    low, high = occ.bbox(shape)
    return min(LINEAR_MAX_MM, max(LINEAR_MIN_MM, LINEAR_RELATIVE * math.dist(low, high)))


def write_glb(step: Path, glb: Path) -> dict[str, Any]:
    """Tessellate the assembly STEP and write it as binary glTF (metres, Y up, node names = products)."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.collections import IndexedDataMap_TCollection_AsciiString_TCollection_AsciiString as Metadata
    from OCP.collections import Sequence_TDF_Label
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import RWMesh_CoordinateSystem, RWMesh_NameFormat
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_AsciiString, TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    if reader.ReadFile(str(step)) != IFSelect_RetDone or not reader.Transfer(doc):
        raise occ.GeometryError(f"cannot read {step} for tessellation")
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    linear = 0.0
    for index in range(1, roots.Length() + 1):
        shape = tool.GetShape_s(roots.Value(index))
        linear = deflection(shape)
        BRepMesh_IncrementalMesh(shape, linear, False, ANGULAR_RAD, True)
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(glb)), True)
    writer.SetNodeNameFormat(RWMesh_NameFormat.RWMesh_NameFormat_Product)
    writer.SetMeshNameFormat(RWMesh_NameFormat.RWMesh_NameFormat_Product)
    writer.SetMergeFaces(True)
    converter = writer.ChangeCoordinateSystemConverter()
    converter.SetInputLengthUnit(0.001)
    converter.SetInputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
    if not writer.Perform(doc, Metadata(), Message_ProgressRange()):
        raise occ.GeometryError(f"cannot write {glb}")
    return {"format": "glb", "units": "m", "up": "+Y", "source": step.name,
            "linear_deflection_mm": linear, "angular_deflection_rad": ANGULAR_RAD}


def gltf_json(glb: Path) -> dict[str, Any]:
    data = glb.read_bytes()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, 12)
    if magic != b"glTF" or chunk_type != b"JSON":
        raise occ.GeometryError(f"{glb} is not a binary glTF file")
    return json.loads(data[20:20 + chunk_length])


def part_map(glb: Path, products: dict[str, str]) -> dict[str, Any]:
    """PN -> glTF nodes and meshes, matched on the PN-first product names the GLB carries."""
    gltf = gltf_json(glb)
    meshes = gltf.get("meshes", [])
    parts: dict[str, Any] = {pn: {"product": name, "nodes": [], "node_indices": [], "meshes": []}
                             for pn, name in sorted(products.items())}
    for index, node in enumerate(gltf.get("nodes", [])):
        match = PN_PREFIX.match(node.get("name", ""))
        if not match or match.group(1) not in parts:
            continue
        entry = parts[match.group(1)]
        entry["nodes"].append(node["name"])
        entry["node_indices"].append(index)
        if "mesh" in node:
            entry["meshes"].append(meshes[node["mesh"]].get("name", f"mesh{node['mesh']}"))
    return parts


def watertight(glb: Path, pns: Iterable[str]) -> dict[str, dict[str, Any]]:
    """Per PN: whether its triangles, welded by position, form a closed 2-manifold.

    A triangle whose corners weld to fewer than three vertices is dropped first: it has no area
    and bounds nothing. BRepMesh emits one wherever a face boundary meets a sphere pole (a ball-end
    channel end). Dropping it removes one degenerate edge and two coincident uses of a real edge,
    so it cannot close a hole: a gap still leaves edges that only one remaining triangle uses.
    """
    import trimesh

    scene = trimesh.load(str(glb), force="scene", process=False)
    pieces: dict[str, list[Any]] = {pn: [] for pn in pns}
    for node_name in scene.graph.nodes_geometry:
        match = PN_PREFIX.match(node_name)
        if match and match.group(1) in pieces:
            transform, geometry = scene.graph[node_name]
            pieces[match.group(1)].append(scene.geometry[geometry].copy().apply_transform(transform))
    report: dict[str, dict[str, Any]] = {}
    for pn, meshes in sorted(pieces.items()):
        if not meshes:
            report[pn] = {"watertight": False, "triangles": 0, "reason": "no mesh node for this part in the GLB"}
            continue
        mesh = trimesh.util.concatenate(meshes)
        mesh.merge_vertices(merge_tex=True, merge_norm=True)
        faces = mesh.faces
        collapsed = (faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2]) | (faces[:, 0] == faces[:, 2])
        mesh.update_faces(~collapsed)
        report[pn] = {"watertight": bool(mesh.is_watertight), "triangles": int(len(mesh.faces)),
                      "collapsed_triangles": int(collapsed.sum()), "euler_number": int(mesh.euler_number)}
    return report
