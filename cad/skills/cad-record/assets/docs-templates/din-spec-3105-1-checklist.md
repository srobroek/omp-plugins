# DIN SPEC 3105-1 open-hardware documentation checklist

Use this project checklist to prepare a review against the current DIN SPEC
3105-1 text. It is a working aid, not a substitute for the normative document.
Mark each item and record the exact evidence path and released revision.

| Review item | Design-record evidence | Generated guide section | Status / evidence reference |
|---|---|---|---|
| Project purpose and scope are clear | `hw/product.yaml`, `hw/requirements.yaml` | Overview | |
| Hardware interfaces are understandable | `hw/interfaces.yaml`, `hw/assembly.yaml` | Assembly steps | |
| Parts and assembly are identifiable | `hw/assembly.yaml`, `hw/parts/<PN>/part.yaml`, `hw/bom.csv` | Parts to make; Parts to buy; Assembly steps | |
| Manufacturing information is provided | `hw/parts/<PN>/part.yaml`, `hw/parts/<PN>/model.py` | Parts to make | |
| Design decisions and rationale are traceable | `hw/decisions/DR-###.md` | Overview | |
| Verification methods and results are recorded | `hw/requirements.yaml`, `hw/verification.csv` | Checks before use | |
| Released artifacts and revision are identified | `hw/releases/<rev>/manifest.json` | Overview | |
| Build and use documentation is available | GitBuilding generated `index.md`, `hw/` record | All generated sections | |
| Documentation states its license and reuse terms | Project documentation and repository license | Overview | |
| Changes after release are identified and reviewable | Revisioned `hw/parts/<PN>/part.yaml`, release manifests, decision records | Overview; Parts to make; Parts to buy | |
