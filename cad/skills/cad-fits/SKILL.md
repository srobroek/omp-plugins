---
name: cad-fits
description: Computes ISO 286 hole/shaft limits, fit type, and 1D worst-case/RSS tolerance stack-ups. Triggers on "what fit for", "H7/g6 limits", "stack-up", "tolerance chain".
---

# CAD Fits and Stack-ups

Stage L3 DETAIL, and the L4 ANALYSIS stack-up check. Numbers come from the scripts, never from memory.

TRIGGER
+ choosing or checking a fit for a bore, pin, bearing seat, or press fit
+ "what are the limits of 25 H7/k6", "is H7/p6 an interference fit"
+ a 1D tolerance chain, end float, gap, or clearance stack-up against a requirement
- general tolerances, GD&T frames, or drawing callouts → `cad-drawings`
- interference or clearance between solid models → `cad-analysis`

## Workflow

1. Fit limits: `uv run --script skill://cad-fits/scripts/fits.py SIZE FIT [--expect TYPE]`.
   SIZE is nominal mm; FIT is `H7/g6` or one class (`g6`); TYPE is `clearance|transition|interference`.
   → JSON with deviations in µm, limits in mm, `max_clearance_um`, `min_clearance_um`, and `fit.type`.
2. Record the chosen class in the part's `model.py` and on its drawing. A fit chosen to meet a
   requirement cites its REQ-### and gets a DR-### entry.
3. Stack-up: write the chain as YAML (format in the `scripts/stackup.py` docstring: contributors with
   `nominal`, `tol` or `tol_plus`/`tol_minus`, `direction` 1|-1; optional `requirement` min/max/method),
   then run `uv run --script skill://cad-fits/scripts/stackup.py STACK.yaml` for a standalone result.
   With `--hw hw --version vN`, the script publishes `results.json` to `hw/analysis/vN/<stack-id>/` and reuses a
   matching bundle; changed recipes require `--replace`. Standalone `--out` destinations must be under `.cad-work`.

Exit codes for both scripts: 0 pass; 1 reports that a check failed (`--expect` mismatch or a stack-up requirement).
2 reports invalid usage or an input outside the supported table coverage.

## Coverage

Hole H; shafts c d f g h js k m n p s; grades IT6 through IT11; nominal sizes 0 < size ≤ 120 mm,
from ISO 286-1:2010. Provenance, cross-checks and exclusions: `skill://cad-fits/data/README.md`.

## Rules

MUST Take every limit, deviation, and fit type from `fits.py` output; a size or class it rejects is out of coverage, not an estimate to make by hand.
DEFAULT Govern a stack-up by worst case; `method: rss` needs a DR-### entry that states why.
MUST State the method beside every stack-up result reported to the user.
DEFAULT Express asymmetric tolerances with `tol_plus`/`tol_minus`; the script recentres them on mid-limit.
NOT Report ASME B4.1 inch fits from this skill; no B4.1 table ships here.
NOT Edit `data/iso286.json` without a cited table edition in `data/README.md`.

```text
L1 FIT {size} {fit}: {type}, clearance {max}/{min} µm | STACK {id}: {PASS|FAIL} by {method}, {min} to {max} mm
   Limits -- {hole and shaft limits in mm, only for fits}
   Contributors -- {largest shares only for stack-ups that fail}
```
CAP 80w
