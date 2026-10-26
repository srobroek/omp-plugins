# DIN SPEC 3105-1 open-hardware documentation checklist

Use this project checklist to prepare a review against the current DIN SPEC
3105-1 text. It is a working aid, not a substitute for the normative document.
Mark each item and record the exact evidence path and released revision.

| Review item | Design-record evidence | Status / evidence reference |
|---|---|---|
| Project purpose and scope are clear | `hw/product.yaml`, `hw/requirements.yaml` | |
| Hardware interfaces are understandable | `hw/interfaces.yaml`, `hw/assembly.yaml` | |
| Parts and assembly are identifiable | `hw/assembly.yaml`, `hw/parts/<PN>/part.yaml`, `hw/bom.csv` | |
| Manufacturing information is provided | `hw/parts/<PN>/part.yaml`, `hw/parts/<PN>/model.py` | |
| Design decisions and rationale are traceable | `hw/decisions/DR-###.md` | |
| Verification methods and results are recorded | `hw/requirements.yaml`, `hw/verification.csv` | |
| Released artifacts and revision are identified | `hw/releases/<rev>/manifest.json` | |
| Build and use documentation is available | GitBuilding `index.md`, `hw/` record | |
| Documentation states its license and reuse terms | Project documentation and repository license | |
| Changes after release are identified and reviewable | Revisioned `hw/parts/<PN>/part.yaml`, release manifests, decision records | |
