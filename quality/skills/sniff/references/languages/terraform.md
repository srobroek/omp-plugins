# Terraform / HCL -- Sniff Reference

Terraform infrastructure-as-code: `.tf` / `.tf.json` files, modules, provider
and backend config. This is a *functional* config format -- the dominant concerns
are security misconfiguration, reliability (state/lifecycle), and maintainability
(duplication, hardcoding), not syntax.

## Detect

How sniff knows Terraform is present: key files, extensions, config.
- Files/extensions: `*.tf`, `*.tf.json`, `*.tfvars`, `*.tfvars.json`
- Module/provider markers: `versions.tf`, `terraform { required_providers { … } }`, `provider "…"` blocks, `.terraform.lock.hcl`
- Backend/state markers: `backend "s3"|"gcs"|"azurerm" { … }`, `terraform.tfstate` (should NOT be committed)
- Config that governs it: `.tflint.hcl`, `.checkov.yaml`, `.trivyignore`, `.terraform-version`

## Tools

Primary first. Exact invocation + machine-readable flag. Canonical detail in
`../tooling.md`; this is the runnable subset.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| tflint | **Run recipe.** Either `cd` to the module dir and run `tflint --format json`, or from the repo root run `tflint --recursive --format json` to walk every module. Run `tflint --init` first to load the provider ruleset (AWS/GCP/Azure). Auto-reads `.tflint.hcl` for enabled plugins/rules (project config governs). **Exit:** 0 = clean · 2 = issues found → parse the JSON `issues[]` (each has `rule`/`message`/`range`) · 1 = a tflint error (bad config, plugin load failure) = INVALID, never "clean". **Gotcha:** without `--init` the provider rules are silently absent -- coverage gap, not a clean run. | provider-aware rules: deprecated syntax, unpinned providers, invalid instance types, unused declarations, naming | default-on | `install-tools.sh --install infra` |
| terraform fmt | **Run recipe.** `terraform fmt -check -recursive` from repo root -- `-check` reports drift without rewriting, `-recursive` descends into submodules; it prints the paths of mis-formatted files. **Exit:** 0 = all canonical · non-zero = drift (the listed files are the finding, advisory style only) · a parse error on malformed HCL = INVALID. Built-in toolchain, no config. | canonical formatting (style); built-in toolchain | default-on | bundled toolchain |
| terraform validate | **Run recipe.** `terraform validate -json` from inside the module dir -- it validates type/reference correctness against an **initialized** module, so `terraform init` (or `-backend=false`) must have run first. **Exit:** 0 = valid (read `valid`/`diagnostics` in the JSON) · 1 = validation diagnostics → parse `diagnostics[]`. **Gotcha:** if the module is not initialized, validate errors out -- do NOT report that as a finding; note "validate skipped, module not initialized" as a coverage gap and lean on tflint instead (CI often lacks init). | type/reference validity within an initialized module; built-in toolchain | default-on | bundled toolchain |
| trivy | **Run recipe (opt-in, security).** `trivy config --format json <dir>` from repo root -- `<dir>` is the Terraform root/module dir (trivy walks it for `.tf`). No tflint-style init needed; reads `.trivyignore` for suppressions. **Exit:** by default 0 even with findings unless `--exit-code 1` is set -- so **do not infer clean from exit 0**; parse the JSON `Results[].Misconfigurations[]` (each has `ID`/`Severity`/`Message`) · a scan/parse crash = INVALID. Security pass, not a code smell. | IaC misconfig: open ingress, public buckets, missing encryption, IAM `*` | opt-in (security pass, not a smell) | `install-tools.sh --install security` |
| checkov | **Run recipe (opt-in, security).** `checkov -d <dir> -o json` from repo root -- `-d` points at the Terraform dir (recurses). Reads `.checkov.yaml` for skips/config if present. **Exit:** 0 = no failed checks · non-zero = failed checks → parse the JSON `results.failed_checks[]` (`check_id`/`check_name`/`file_path`) · a crash = INVALID. Overlaps trivy heavily; reserve checkov for benchmark-grade policy runs. | deep policy checks (1000+ rules): CIS benchmarks, encryption, logging | opt-in (security pass, not a smell) | `install-tools.sh --install security` |

Notes: `tflint` is the provider-aware meta-linter (init plugins with `tflint --init`
to load the AWS/GCP/Azure ruleset); it plus `terraform fmt -check` and
`terraform validate` are the default-on correctness/style pass. `trivy config` and
`checkov` are the **security** pass (opt-in, not smell): they overlap heavily on
misconfig -- run both on a deep pass, but if one is present trivy is faster and
covers the same top-severity findings; reserve checkov for benchmark-grade policy
runs. **tfsec is deprecated -- its rules folded into `trivy config`; use trivy, not
tfsec.** `terraform validate` only checks an *initialized* module (`terraform init`
must have run); skip in CI where init is unavailable and lean on tflint instead.

## Smell checklist

Beyond what tools flag. Each: what it looks like + the idiomatic alternative.

| Smell | What it looks like (Terraform) | Idiomatic alternative |
|-------|--------------------------------|-----------------------|
| Hardcoded values | `region = "us-east-1"`, `ami = "ami-0abc…"`, `cidr_block = "10.0.0.0/16"` inline | `variable`/`locals` + `*.tfvars`; data sources for AMIs (`data.aws_ami`) |
| Copy-paste resources | Near-identical `resource` blocks differing by name/env | Extract a module; iterate with `for_each` |
| `count` vs `for_each` misuse | `count` over a list whose order changes → destroy/recreate churn | `for_each` over a map/set for keyed, stable resources |
| Missing lifecycle guard | Stateful resource (RDS, S3, DynamoDB) with no `prevent_destroy` | `lifecycle { prevent_destroy = true }` on stateful/data resources |
| No remote state / locking | Default local backend, `terraform.tfstate` in repo | `backend "s3"` + DynamoDB lock table (or `gcs`/`azurerm` native locking) |
| Overly permissive IAM | `Action = "*"`, `Resource = "*"`, `Principal = "*"` | Scope actions/resources; least privilege |
| Public ingress | `cidr_blocks = ["0.0.0.0/0"]` on SSH/RDP/DB ports | Restrict to known CIDRs; use SG references / bastions |
| Missing tags | Resources with no `tags` (cost/ownership/compliance) | `default_tags` in provider + per-resource `tags` |
| Unpinned providers | `required_providers` with no version or `>=` floating | Pin `~> X.Y`; commit `.terraform.lock.hcl` |
| Plaintext secrets | `password = "hunter2"`, tokens in `.tf`/`.tfvars` | Secrets manager / Vault data source; mark vars `sensitive = true` |
| No output descriptions | `output "x" { value = … }` with no `description` | Add `description` to every `variable` and `output` |

## Idioms & style authorities

- Terraform Style Guide -- https://developer.hashicorp.com/terraform/language/style
- Module structure & standard module layout -- https://developer.hashicorp.com/terraform/language/modules/develop/structure
- tflint ruleset (AWS) -- https://github.com/terraform-linters/tflint-ruleset-aws/tree/master/docs/rules
- Key conventions: pin provider versions and commit the lock file; factor repeated
  infra into modules with explicit `variable`/`output` (every one documented);
  use `for_each` over `count` for keyed resources to avoid reindex churn; keep all
  environment-specific config in variables/`tfvars`, never inline; enable remote
  state with locking; run `terraform fmt` as the canonical formatter.

## refactoring.guru mappings

| Terraform smell | refactoring.guru smell | Idiomatic refactoring |
|-----------------|------------------------|-----------------------|
| Copy-paste resource blocks | Duplicate Code (`/smells/duplicate-code`) | Extract Class → extract a **module**; iterate with `for_each` |
| Monolithic root with everything inline | Large Class (`/smells/large-class`) | Extract Class → split into composed **child modules** |
| Hardcoded magic regions/AMIs/CIDRs | Primitive Obsession / magic numbers (`/smells/primitive-obsession`) | Replace Magic Number with Symbolic Constant → `variable`/`locals` + data sources |
| Dead/unused `variable`/`resource`/`output` | Dead Code (`/smells/dead-code`) | Delete; tflint `terraform_unused_declarations` flags these |

The catalog is OO-shaped; here "Extract Class" reads as "extract module" and the
fix is composition + `for_each`, not inheritance.

## Pragmatism notes (for the adversarial pass)

- Not every repeated block needs a module. Two uses is borderline -- a module pays
  off at 3+ call sites or when the block has real internal variation. Premature
  modularization adds indirection (Speculative Generality, `/smells/speculative-generality`).
- `count` is fine and idiomatic for simple N-identical-replicas (`count = 3`); the
  smell is only `count` over an order-sensitive *list* of distinct things.
- Some hardcoding is acceptable: a provider's default `region` in a single-region
  module, well-known public constants. Flag hardcoding that blocks reuse or hides a
  secret, not every literal.
- A single local-state throwaway/sandbox module legitimately skips remote backend;
  weight the "no remote state" smell by whether the code looks production-bound.
- Security smells (public `0.0.0.0/0` ingress on admin ports, IAM `*:*`, plaintext
  secrets) are rarely false positives -- weight them high in the severity column.
