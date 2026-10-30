# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Measure a built version's occurrence pairs at the nominal pose the way cad-motion's sweep loads
and places them, through a pair cache shared with cad-model check.

The inputs come from pose.load_inputs, the sweep's own loader of `--version vN`. The placements
are Chain.relative_transforms at the chain's nominal values, and the rule is
RuleVersion.current(MeshBounds), the sweep's default fast-mode rule. Every pair is requested in
exact mode.
Usage: uv run --script share_probe.py HW LABEL CACHE_DIR
stdout: {"kernel_evaluations": n, "exact_hits": n, "readings": {"A B": [distance, volume]}}.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from cadmodel.motion import load_mesh_bound, load_pair_measure, load_pose  # noqa: E402

pose, measure, mesh_bound = load_pose(), load_pair_measure(), load_mesh_bound()
hw, label, cache_dir = Path(sys.argv[1]).resolve(), sys.argv[2], Path(sys.argv[3])
version, folder, record = pose.LAYOUT.built_version(hw, label)
manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
args = argparse.Namespace(hw=hw, version=version, step=None, parts_dir=None, attach=manifest["attach"],
                          record_hw=record, version_dir=folder)
with pose.stdout_to_stderr():
    _, chain, definitions = pose.load_inputs(args)
    ids = sorted(chain.ids)
    pairs = [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]]
    relative = chain.relative_transforms(chain.complete({}), pairs)
    shapes = {pn: part.shape for pn, part in definitions.items()}
    mesh = mesh_bound.MeshBounds(shapes)
    cache = measure.PairCache(cache_dir)
    measurer = measure.PairMeasurer(shapes, geometry_ids=pose.geometry_ids(definitions),
                                    rule=measure.RuleVersion.current(mesh), cache=cache, mesh=mesh)
    requests = [measure.Request(chain.pn(a), chain.pn(b), relative[(a, b)], group=(a, b), mode="exact")
                for a, b in pairs]
    with measurer.session() as session:
        outcomes = session.measure(requests)
    cache.close()
print(json.dumps({"kernel_evaluations": measurer.counters.kernel_evaluations,
                  "exact_hits": measurer.counters.exact_hits,
                  "readings": {f"{a} {b}": [o.distance_mm, o.overlap_mm3] for (a, b), o in zip(pairs, outcomes)}}))
