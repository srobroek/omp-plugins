# FreeCAD simulation runs

For a long `freecad_assembly.py` run, start with `--smoke` to validate FreeCAD discovery, geometry import, constraint solving, and a few motion frames quickly:

```sh
uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/freecad_assembly.py \
  --hw hw --version vN --smoke
```

Smoke mode uses no more than three evenly spaced frames (including the start and end), and writes a JSON summary with `mode: "smoke"` and `evidence: false`. It never reuses or publishes a verification bundle; it is not accepted as evidence of limits or coupled-motion agreement across the full simulation. A smoke failure is useful diagnostic evidence, but a smoke pass only shows that the sampled setup ran. Remove `--smoke` and run the full simulation before recording or relying on the check result.

The simulator waits for its run-specific result JSON to parse and validate (including its run ID, status, and frames) instead of treating the child's exit or mere result-file presence as completion. It then terminates and reaps the FreeCAD process group with bounded TERM→KILL cleanup, because FreeCAD can leave a process alive after writing its result.
