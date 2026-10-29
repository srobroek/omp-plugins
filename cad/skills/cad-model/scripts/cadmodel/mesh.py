"""Binary glTF from the assembly STEP, the occurrence -> mesh-node map, mesh watertightness, and the binary
STL of a manufactured part with its read-back report."""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path
from typing import Any, Mapping

from cadmodel import occ
from cadmodel.motion import load_pose

# Preview tessellation: chord deviation relative to the assembly diagonal, clamped; angular deflection in rad.
# A manufacturing STL takes the absolute deflections of its part's manufacturing policy instead.
LINEAR_RELATIVE, LINEAR_MIN_MM, LINEAR_MAX_MM, ANGULAR_RAD = 5e-4, 0.01, 0.2, 0.25
DEGENERATE_MM2 = 1e-12  # a welded triangle with no more area than this bounds nothing
STL_HEADER, STL_RECORD = 84, 50  # binary STL: 80-byte header and uint32 count, then 50 bytes per triangle
MATCH = ("a node belongs to the occurrence whose instance name it carries: `<PN> <title>` for a part placed "
         "once without an id, `<PN> <title> [@id]` for an explicit occurrence")


def deflection(shape: Any) -> float:
    low, high = occ.bbox(shape)
    return min(LINEAR_MAX_MM, max(LINEAR_MIN_MM, LINEAR_RELATIVE * math.dist(low, high)))


def _name_untagged_instances(tool: Any) -> None:
    """Name each component that carries no `[@id]` after its product, so instance node names are
    product names for a legacy singleton (the STEP reader names an unnamed component `=>[0:1:1:2]`)."""
    from OCP.collections import Sequence_TDF_Label
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.XCAFDoc import XCAFDoc_ShapeTool

    def name(label: Any) -> str:
        attribute = TDataStd_Name()
        return attribute.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attribute) else ""

    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    for index in range(1, roots.Length() + 1):
        components = Sequence_TDF_Label()
        XCAFDoc_ShapeTool.GetComponents_s(roots.Value(index), components, True)
        for number in range(1, components.Length() + 1):
            component = components.Value(number)
            referred = TDF_Label()
            if load_pose().OCCURRENCE_TAG.search(name(component)) or not XCAFDoc_ShapeTool.GetReferredShape_s(
                    component, referred):
                continue
            TDataStd_Name.Set_s(component, TCollection_ExtendedString(name(referred)))


def write_glb(step: Path, glb: Path) -> dict[str, Any]:
    """Tessellate the assembly STEP and write it as binary glTF (metres, Y up).

    Node names are instance names (`_name_untagged_instances`), mesh names product names; every
    occurrence is its own node, each with its own mesh."""
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
    _name_untagged_instances(tool)
    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    linear = 0.0
    for index in range(1, roots.Length() + 1):
        shape = tool.GetShape_s(roots.Value(index))
        linear = deflection(shape)
        BRepMesh_IncrementalMesh(shape, linear, False, ANGULAR_RAD, True)
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(glb)), True)
    writer.SetNodeNameFormat(RWMesh_NameFormat.RWMesh_NameFormat_Instance)
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


def instance_names(chain: Any, products: Mapping[str, str]) -> dict[str, str]:
    """Occurrence id -> the GLB node name its instance carries."""
    pose = load_pose()
    return {oid: pose.component_name(pose.Part(chain.pn(oid), products[chain.pn(oid)], None),
                                     chain.inventory.get(oid)) or products[chain.pn(oid)]
            for oid in chain.ids}


def part_map(glb: Path, chain: Any, products: Mapping[str, str]) -> dict[str, Any]:
    """The part map (build adds its schema_version): glTF nodes and meshes per occurrence, matched on
    exact instance names, plus their PN aggregate under `parts`."""
    gltf = gltf_json(glb)
    meshes = gltf.get("meshes", [])
    names = instance_names(chain, products)
    by_name: dict[str, str] = {name: oid for oid, name in names.items()}
    occurrences: dict[str, Any] = {oid: {"PN": chain.pn(oid), "ref": chain.ref(oid), "nodes": [], "node_indices": [],
                                         "meshes": []} for oid in chain.ids}
    for index, node in enumerate(gltf.get("nodes", [])):
        oid = by_name.get(node.get("name", ""))
        if oid is None:
            continue
        entry = occurrences[oid]
        entry["nodes"].append(node["name"])
        entry["node_indices"].append(index)
        if "mesh" in node:
            entry["meshes"].append(meshes[node["mesh"]].get("name", f"mesh{node['mesh']}"))
    parts: dict[str, Any] = {}
    for oid in sorted(chain.ids, key=lambda o: (chain.pn(o), o)):
        entry = parts.setdefault(chain.pn(oid), {"product": products[chain.pn(oid)], "occurrences": [], "nodes": [],
                                                 "node_indices": [], "meshes": []})
        entry["occurrences"].append(oid)
        for key in ("nodes", "node_indices", "meshes"):
            entry[key] += occurrences[oid][key]
    return {"glb": glb.name, "match": MATCH,
            "parts": dict(sorted(parts.items())), "occurrences": occurrences}


def watertight(glb: Path, nodes: Mapping[str, str]) -> dict[str, dict[str, Any]]:
    """Per occurrence (`nodes`: id -> GLB node name): whether its triangles, welded by position
    (`welded`), form a closed 2-manifold. Each occurrence is judged alone, never welded to another
    instance."""
    import trimesh

    scene = trimesh.load(str(glb), force="scene", process=False)
    owner = {name: oid for oid, name in nodes.items()}
    pieces: dict[str, list[Any]] = {oid: [] for oid in nodes}
    for node_name in scene.graph.nodes_geometry:
        if node_name in owner:
            transform, geometry = scene.graph[node_name]
            pieces[owner[node_name]].append(scene.geometry[geometry].copy().apply_transform(transform))
    report: dict[str, dict[str, Any]] = {}
    for oid, meshes in sorted(pieces.items()):
        if not meshes:
            report[oid] = {"watertight": False, "triangles": 0, "reason": "no mesh node for this occurrence in the GLB"}
            continue
        mesh, collapsed = welded(trimesh.util.concatenate(meshes))
        report[oid] = {"watertight": bool(mesh.is_watertight), "triangles": int(len(mesh.faces)),
                       "collapsed_triangles": collapsed, "euler_number": int(mesh.euler_number)}
    return report


def welded(mesh: Any) -> tuple[Any, int]:
    """`mesh` welded by position, its collapsed triangles dropped, and how many were dropped.

    A triangle whose corners weld to fewer than three vertices is dropped: it has no area and
    bounds nothing. BRepMesh emits one wherever a face boundary meets a sphere pole (a ball-end
    channel end). Dropping it removes one degenerate edge and two coincident uses of a real edge,
    so it cannot close a hole: a gap still leaves edges that only one remaining triangle uses.
    """
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    faces = mesh.faces
    collapsed = (faces[:, 0] == faces[:, 1]) | (faces[:, 1] == faces[:, 2]) | (faces[:, 0] == faces[:, 2])
    mesh.update_faces(~collapsed)
    return mesh, int(collapsed.sum())


def write_stl(shape: Any, path: Path, linear_mm: float, angular_rad: float) -> None:
    """Tessellate `shape` with absolute deflections and write it as binary STL, in its own units (mm)."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.StlAPI import StlAPI_Writer

    BRepMesh_IncrementalMesh(shape, linear_mm, False, angular_rad, True)
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    with load_pose().stdout_to_stderr():
        if not writer.Write(shape, str(path)):
            raise occ.GeometryError(f"cannot write {path}")


def _shells(faces: Any, vertices: int) -> int:
    """Connected components of a welded mesh: triangles sharing a vertex are one shell."""
    parent = list(range(vertices))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, c in faces.tolist():
        ra = root(a)
        for other in (b, c):
            ro = root(other)
            if ro != ra:
                parent[ro] = ra
    return len({root(i) for i in set(faces.flatten().tolist())})


def stl_report(path: Path) -> dict[str, Any]:
    """What a manufacturing STL holds, read back: binary layout, finite coordinates, and after welding by
    position (`welded`) its degenerate triangles, closure, winding, signed volume, shells and box."""
    import numpy as np
    import trimesh

    data = path.read_bytes()
    count = struct.unpack_from("<I", data, 80)[0] if len(data) >= STL_HEADER else -1
    binary = len(data) == STL_HEADER + STL_RECORD * count
    loaded = trimesh.load(str(path), file_type="stl", process=False, force="mesh")
    finite = bool(np.isfinite(loaded.vertices).all())
    mesh, collapsed = welded(loaded)
    degenerate = int((mesh.area_faces <= DEGENERATE_MM2).sum()) if finite else None
    low, high = mesh.bounds if len(mesh.faces) else (np.zeros(3), np.zeros(3))
    return {"binary": binary, "triangles": count, "finite": finite, "collapsed_triangles": collapsed,
            "degenerate_triangles": degenerate, "watertight": bool(mesh.is_watertight),
            "winding_consistent": bool(mesh.is_winding_consistent),
            "volume_mm3": float(mesh.volume) if finite else None,
            "shells": _shells(mesh.faces, len(mesh.vertices)),
            "bbox_mm": {"min": [float(v) for v in low], "max": [float(v) for v in high]},
            "max_abs_mm": float(np.abs(mesh.vertices).max()) if len(mesh.vertices) else 0.0}


def node_names(part_map_data: Mapping[str, Any]) -> dict[str, str]:
    """Occurrence id -> GLB node name from a written part map (version 1: PN -> its first node)."""
    if part_map_data.get("schema_version", 1) == 1:
        return {pn: entry["nodes"][0] for pn, entry in part_map_data["parts"].items() if entry["nodes"]}
    return {oid: entry["nodes"][0] for oid, entry in part_map_data["occurrences"].items() if entry["nodes"]}
