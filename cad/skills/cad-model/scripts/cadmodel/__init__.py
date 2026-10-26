"""cad-model: run part model scripts, then check and diff the versions they produce.

Kernel-neutral below the runners: every module here works on raw OCP `TopoDS_Shape` values, so
the CadQuery 2.8 (OCP 7.9) and build123d 0.13 (OCP 8.0) runners share one implementation.
"""
