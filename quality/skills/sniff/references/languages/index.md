# Language & Format Index

Route each detected **target** to its self-contained reference doc. "Target"
means any sniffable surface -- a programming language, a config/data format, an
API contract, OR an infra target (Terraform, Dockerfile, Kubernetes, CI). The
directory is named `languages/` for history, but it holds docs for ALL of these;
treat infra/config/contract docs as first-class, not afterthoughts. In step 1,
map the detected stack to these docs; load (or hand to a `bloodhound`) only the
docs for targets actually present.

Each doc is independent and follows `_template.md`. To add a language, copy the
template, fill it, and add a row here -- nothing else in the package needs to
change.

## Core languages

| Language | Doc | Detect by |
|----------|-----|-----------|
| Rust | `rust.md` | `Cargo.toml`, `*.rs` |
| Go | `go.md` | `go.mod`, `*.go` |
| TypeScript / JS | `typescript.md` | `tsconfig.json`, `package.json`, `*.ts/*.tsx/*.js` |
| Python | `python.md` | `pyproject.toml`, `setup.py`, `*.py` |
| Shell / Bash | `shell.md` | `*.sh`, `*.bash`, shebang `#!/.../bash` |
| SQL | `sql.md` | `*.sql`, migration dirs |

## Frontend

| Language | Doc | Detect by |
|----------|-----|-----------|
| React | `react.md` | `*.tsx/*.jsx`, `react` in deps |
| Vue | `vue.md` | `*.vue`, `vue` in deps |
| Svelte | `svelte.md` | `*.svelte`, `svelte` in deps |
| CSS / SCSS | `css.md` | `*.css`, `*.scss` |

## Data & config formats

| Format | Doc | Detect by |
|--------|-----|-----------|
| JSON | `json.md` | `*.json` |
| YAML (pure format) | `yaml.md` | `*.yml`, `*.yaml` (non-functional) |
| TOML | `toml.md` | `*.toml` |

## API contracts

| Format | Doc | Detect by |
|--------|-----|-----------|
| OpenAPI | `openapi.md` | `openapi.yaml`, `swagger.json`, `openapi:`/`swagger:` key |
| GraphQL | `graphql.md` | `*.graphql`, `*.gql`, schema files |
| Protobuf | `protobuf.md` | `*.proto`, `buf.yaml` |

## Infrastructure (functional implementations of a format)

These cover the *semantic* smells of a tool that uses YAML/HCL -- distinct from
the pure-format docs above (the format-vs-functional split).

| Target | Doc | Detect by |
|--------|-----|-----------|
| Terraform / HCL | `terraform.md` | `*.tf`, `*.hcl` |
| Dockerfile | `dockerfile.md` | `Dockerfile`, `*.dockerfile` |
| Kubernetes | `kubernetes.md` | `*.yaml` with `apiVersion:`/`kind:`, `kustomization.yaml` |
| CI/CD | `ci-cd.md` | `.github/workflows/*.yml`, `.gitlab-ci.yml`, etc. |

## Docs

| Format | Doc | Detect by |
|--------|-----|-----------|
| Markdown | `markdown.md` | `*.md`, `*.mdx` |

## Authoring

`_template.md` is the authoring template. Every doc has the same sections:
Detect · Tools · Smell checklist · Idioms & style authorities · refactoring.guru
mappings · Pragmatism notes.
