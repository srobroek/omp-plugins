# Optional fillet fallback for model scripts

A fillet can fail for a local edge/radius even when the rest of a part is valid. `cadmodel.fillets.fillet_edge` is an opt-in helper for cosmetic edges: it tries the requested radius, then progressively halves it after OpenCascade `StdFail_NotDone`. If all attempts fail, the helper leaves that edge sharp and logs a warning. The model runner captures these warnings into the build result, so a skipped feature is visible in the build report.

```python
from cadmodel.fillets import fillet_edge

# Cosmetic edge: after the requested radius and two smaller attempts, skip on failure.
body = fillet_edge(body, edge, 1.0, name="outer cosmetic round")

# A functional radius is part of the fit/design contract: kernel failure remains fatal.
body = fillet_edge(body, bearing_edge, 0.5, functional=True, name="bearing seat")
```

The default is two retries (r, r/2, r/4). Set `retries` to another non-negative integer when a model needs a different bounded search. Only `StdFail_NotDone` triggers fallback; invalid arguments and other exceptions still fail the build. Edges are attempted individually, so a failed cosmetic edge does not prevent later model operations. Use `functional=True` whenever the round controls a seal, fit, bearing, strength, or other required geometry; this mode re-raises the final `StdFail_NotDone` rather than silently weakening the part.

This helper does not choose edges or radii and does not change a model unless the author calls it. It works with CadQuery, build123d, or raw shapes whose `fillet(radius, [edge])` operation returns the same shape abstraction. CadQuery and build123d models may import it from their shared `cadmodel` helpers; no dependency is added.

Warnings are reported at build level as `warnings: [{pn, message}]`, and are also attached to the successful part's runner result. They are not failures, but should be reviewed before accepting the built geometry.
