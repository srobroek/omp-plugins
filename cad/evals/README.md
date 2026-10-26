# cad evals

Cross-harness, cross-model evaluation of the `cad` plugin. Each trial gives one
agent harness (OMP, Claude Code, Kiro, OpenCode) on one model a design task in a
fresh sandbox. Programmatic graders then check what the agent left behind against
hidden ground truth. The output follows the ratchet runner contract, so a cell
directory can serve as a `ratchet` variant.

## Layout

| Path | What it holds |
|---|---|
| `cases/<id>.case.json` | One case. Format: `cases/case.schema.json` (JSON Schema 2020-12) |
| `cases/seeds/<name>/` | Files copied into the sandbox before the first turn (a seed `hw/` design record) |
| `truth/<id>/truth.json` | Hidden expected geometry, with where it came from |
| `truth/<id>/oracle/` | Hidden reference answer (`part.yaml`, `model.py`), used only by the pre-flight tests |
| `matrix.toml` | Cells (harness × model), reps, pilot, judge, retry and timeout settings |
| `run.py` | CLI: `plan`, `run`, `grade`, `judge`, `smoke` |
| `runner.py` | Trial staging, turns, scripted gate answers, retries, result rows |
| `adapters/` | One adapter per harness: plugin install, exact argv, stream parser |
| `graders/` | `score.py` (metrics), `step_readback.py` (OCCT, uv env), `record_check.py` (YAML, uv env), `judge.py` (pairwise hook) |
| `tests/` | Pre-flight tests, a stand-in harness binary, sanitised smoke streams |
| `smoke/` | The latest live smoke per harness (`<harness>.json`), failed earlier attempts (`<harness>-attempts.json`), and `kiro-store-control.json`, the same user-store check over a window with no trial running |

## Requirements

- Python 3.11 or newer for the runner and adapters. They use only the standard library.
- `uv` on `PATH`. The graders run as PEP 723 scripts:
  - `step_readback.py` uses `cadquery-ocp-novtk` 8.0.x;
  - `record_check.py` uses `pyyaml`.
  The oracles use `cadquery` 2.8 and `build123d` 0.13, each in its own environment. The tests cache built oracle STEP files by model hash in `~/.cache/cad-evals/oracle-steps`.
- The AWS CLI and a Bedrock profile (`[auth] aws_profile`, default `$AWS_PROFILE`); the runner exports its credentials for each trial.
- The harness CLIs for the cells you run.

## Cases and ground truth

A case names its `id` and `tier`:

- `T1`: one part;
- `T2`: a subassembly;
- `T3`: the full product flow.

It also names `tags`, where `tags[0]` is the ratchet split stratum, plus `kernel`, `prompt` and `gate_answers`. Each gate answer is a `when` regex, a `reply` and `max_uses`. The case also gives `seed`, `deliverables` (part number, a legacy STEP path, record directory) and `truth`.

The seed (`cases/seeds/desk-lamp/hw/`) is a complete design record that passes the real cad-record validator: product, requirements, interfaces, assembly, one purchased pin part, `bom.csv` and `verification.csv`. A T1 task adds one part, its BOM row and its build, and the record must still validate.

The runner keeps ground truth away from the model under test. The protections:

- The sandbox is a new temporary directory outside the repository. It receives the seed and a fresh `git init`. Each attempt gets its own sandbox, and the runner deletes it afterwards.
- The plugin is staged into the trial as a copy of `cad/` without `evals/`. A harness that loads the plugin never sees `truth/`.
- Each harness stream is scanned for the truth directory. A hit files the attempt as `truth_leak` instead of scoring it.
- Residual risk: an agent with a shell can still read any absolute path on the host. Containers or a separate user would close that gap; this runner uses neither.

The seed cases are three T1 parts from a desk lamp:

| Case | Kernel | Part | Checks |
|---|---|---|---|
| `t1-lower-link-cq` | CadQuery 2.8 | LAL-0001 lamp arm lower link, 2 × Ø5.5 pin holes at 120 mm | holes, volume, envelope |
| `t1-lower-link-b3d` | build123d 0.13 | the same link | the same, through the other kernel |
| `t1-base-plate-cq` | CadQuery 2.8 | LBP-0001 base plate, 4 × Ø4.5 on 64 mm square + Ø8.5 centre | hole pattern, volume, envelope |

Each truth value is computed analytically from the prompt; the provenance is in each `truth.json`. No truth value comes from a model's output. The oracle answers are checked against the truth values, not the other way round.

## Graders

Programmatic checks come first. Each metric is 0 or 1; `score` is their mean, and `pass` is 1 only when every metric is 1.

| Metric | Check |
|---|---|
| `step` | The part's STEP exists and OCCT reads it into a shape. Its path comes from `hw/versions/latest.json` (`parts[PN]`, relative to hw/, the cad-model build index). Only a record without that index falls back to the case's legacy `step` path |
| `ap242` | The header is ISO 10303-21 and `FILE_SCHEMA` declares `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING…` |
| `solids` | The solid count equals the truth |
| `volume` | The volume is within `volume_rel_tol` of the truth |
| `bbox` | The sorted envelope extents are within `bbox_tol_mm`, so orientation does not matter |
| `holes` | Concave cylinders, deduplicated per axis, give exactly the truth count per diameter within `hole_tol_mm`, with no extra holes |
| `record` | `hw/parts/<PN>/part.yaml` and `model.py` exist and name the PN, and the whole record validates |

The `record` metric runs `cad/skills/cad-record/scripts/validate.py <hw-dir>` unchanged, with its exit codes: 0 valid, 1 invalid, 2 infrastructure error. The grader never relaxes it; seeds and oracles are complete records instead. Without the script (a checkout predating cad-record), a builtin check applies the shared-contract rules: the PN and rev patterns, the `process` enum, and the `product.yaml` units, rigor and regime.

A grader that cannot run (exit 2, timeout, bad JSON) raises `grader_error`. The runner writes that to `errors.jsonl`, never as a zero.

The pairwise judge hook (`graders/judge.py`, `run.py judge`) compares two cell or variant directories case by case:

- The candidates are the collected `artifacts/<id>_rep<k>/`.
- Presentation order is randomised and mapped back.
- A tie is a valid answer.
- Candidates are wrapped as untrusted data.
- An empty candidate loses without a model call.

The judge is Sonnet 5.5 through OMP with tools, skills, rules and extensions off. It must differ from every model under test.

## Commands

All commands run from the repository root. Prefix with `GIT_TERMINAL_PROMPT=0` in unattended shells.

```sh
# Pre-flight: oracle ~100 %, empty ~0 %, induced adapter error -> errors.jsonl,
# stable regrade, resume, gates, isolation verdicts, judge mapping, recorded streams. No model calls.
python3 -m unittest discover -s cad/evals/tests -v
# Only the fast, model-free checks (skips the oracle builds and OCCT read-back).
CAD_EVALS_SKIP_GEOMETRY=1 python3 -m unittest discover -s cad/evals/tests -v

# See what would run, with the exact argv per cell. No model calls.
python3 cad/evals/run.py plan --pilot

# Pilot: the [pilot] cases (3) x 1 rep in every cell. Traces for all pilot cases.
python3 cad/evals/run.py run --pilot --out cad/evals/out/pilot

# Full matrix: every case x reps (2) x every cell. Traces only for train ids.
python3 cad/evals/run.py run --out cad/evals/out/matrix --train-ids train-ids.txt

# Narrow to cells or cases; repeat the flags as needed.
python3 cad/evals/run.py run --cell omp:amazon-bedrock/global.anthropic.claude-opus-5-5 \
  --case t1-lower-link-cq --out cad/evals/out/dev

# Grade a directory by hand (for example a kept sandbox's work/).
python3 cad/evals/run.py grade --case t1-lower-link-cq --work /path/to/work

# Per-cell comparison table; contaminated cells are listed but excluded.
python3 cad/evals/run.py summary --out cad/evals/out/matrix

# Pairwise judge between two cells (or two ratchet variants). Refuses contaminated cells.
python3 cad/evals/run.py judge --a cad/evals/out/matrix/omp--global.anthropic.claude-opus-5-5 \
  --b cad/evals/out/matrix/claude--global.anthropic.claude-opus-5-5 --out cad/evals/out/judge.jsonl

# Model-free isolation check (OMP): what a clean trial loads.
python3 cad/evals/run.py inventory --harness omp --model amazon-bedrock/global.anthropic.claude-haiku-5-5

# One cheap live call in a clean trial: served model, usage, inventory, leaks, raw stream, and what the trial
# left on the host (shared temp entries, user-store changes). Exits 0 only when isolation is clean and the
# host shows no change.
python3 cad/evals/run.py smoke --harness omp --model amazon-bedrock/global.anthropic.claude-haiku-5-5 --out /tmp/smoke
```

A rerun into the same `--out` resumes:

- a `(case, rep)` with a row in `results.jsonl` is skipped;
- a slot that only errored runs again.

To retry a whole cell, delete its directory. `--keep-sandboxes` keeps each trial directory for inspection, and `--concurrency` overrides the matrix value.

The pilot writes traces for every pilot case because no split exists yet. A ratchet variant run must pass `--train-ids`, one case id per line, so that test cases never get transcripts.

## Output (one directory per cell, `<harness>--<model>`)

- `results.jsonl`: one row per scored `(case, rep)`, appended as each one finishes. Fields:
  - `prompt_id`, `rep`, `prompt`, `tags`;
  - `grade` (the metric map above), `explanation`, `status` (`ok`, or `truncated` when the turns ran out or the model hit its length limit);
  - `model` (the served id, read from the stream), `usage`, `latency_s`;
  - `harness`, `requested_model`, `turns`, `retries`;
  - `isolation` (`clean` or `contaminated`), `leaks`, `inventory` and `isolation_mechanism`. `inventory` holds what the harness reported loading, the harness `version` when it reports one, and `baseline`: the bundled items this run loaded that no supported setting removes (`loaded`) and the harness version that list was declared for (`declared_for`).
- `errors.jsonl`: attempts with nothing scorable, each with a `failure_class`:

  | Class | Meaning |
  |---|---|
  | `adapter_error` | The harness exited non-zero or wrote an empty stream |
  | `provider_error` | The stream reported a failed turn |
  | `timeout` | The per-case wall-clock ceiling (`case_timeout_s`) was hit; the process group is killed |
  | `model_mismatch` | The served model is not the requested one |
  | `model_unverified` | The stream carried no served model |
  | `truth_leak` | The stream mentions the hidden truth directory |
  | `plugin_missing` | The staged plugin lacks what the harness loads |
  | `auth_error` | AWS credentials could not be exported from the `[auth]` profile |
  | `grader_error` | A grader could not run |
  | `runner_error` | An unexpected runner exception |

  Throttling, 5xx and connection errors are retried with jittered exponential backoff (`[retry]`). The number of retries is recorded. A low grade is never retried.
- `traces/<id>_rep<k>.json`: the transcript as `[{role, content, thinking?, name?}]`, for train ids only. `raw/` holds the raw streams of the same slots.
- `artifacts/<id>_rep<k>/`: the case's `collect` directory, kept as input to the judge.

`usage` uses OMP key names: `input`, `output`, `cacheRead` and `cacheWrite`, plus `cost_usd` when the harness reports it and `credits` for Kiro.

## Isolation

Trials are comparable only if each harness loads the cad plugin and nothing else of the user's. Every child process gets an environment built from an allowlist (`PATH`, locale, user, uv cache locations); nothing else of the user's shell is inherited. `TMPDIR`, `TMP` and `TEMP` point at the trial's own `tmp/`, which is removed with the trial; Claude Code also gets `CLAUDE_CODE_TMPDIR`, because its own temp root is `/tmp` on macOS whatever `TMPDIR` says ([env vars](https://code.claude.com/docs/en/env-vars)). AWS credentials are exported once per window from the `[auth]` profile (`aws configure export-credentials`) and passed as environment variables, so no harness reads `~/.aws` or runs the profile's credential process.

Each row then records what the harness itself reported loading, and the leaks: everything that is neither the cad plugin nor in that harness's declared baseline, plus any capability cad needs that is missing. A baseline is what a harness bundles and no supported setting removes, observed in a clean run of one harness version. Each row's `inventory.baseline` lists the baseline items it loaded and the version they were declared for, and a row whose harness reports another version leaks `baseline: declared for …`. An inventory the harness did not report counts as contaminated. `summary` and `judge` refuse contaminated cells unless `--allow-contaminated`.

| Harness | Mechanism | Inventory source | Smoke result (`smoke/`) |
|---|---|---|---|
| OMP 18.12.3 | HOME, `PI_CODING_AGENT_DIR`, `XDG_*` and `TMPDIR` in the trial; cad via `--plugin-dir` | `omp --mode rpc` after the turn: `get_state` (the assembled system prompt: skills, rules, project context, MCP; the task tool's agents) and `get_available_commands` | clean: the cad skills and reviewers, plus the baseline (OMP's bundled agents and commands). Nothing added to the shared temp directories |
| Claude Code 2.1.310 | The real binary behind the Amazon toolbox launcher, which otherwise copies Amazon builder rules into the rules directory; `CLAUDE_CONFIG_DIR` in the trial; `--setting-sources project,local`; a trial `--settings` that pins the model (`modelOverrides`) and disables the two `@builtin` plugins; the bundled-component switches below; `TMPDIR` and `CLAUDE_CODE_TMPDIR` in the trial; `--strict-mcp-config` with an empty `--mcp-config`; cad via `--plugin-dir` | `system/init` in the first turn (version, plugins, skills, agents, commands, MCP, tools, memory path) plus the config dir's `rules/` and `CLAUDE.md` on disk | clean: `plugins: [cad]`, only cad skills and agents, the 28 built-in commands of the baseline, served `claude-haiku-5-5`. Its temp folder (`claude-<uid>/<work dir>`) landed in the trial; earlier runs had left such folders in `/tmp/claude-<uid>`. Earlier attempts: `smoke/claude-attempts.json` (without `modelOverrides` Opus served; `--bare` removes the Skill, Task, Write, Glob and Grep tools, so it is off) |
| Kiro 2.34.0 (v3) | HOME, `XDG_*` and `TMPDIR` in the trial; a trial-own Kiro database holding a read-only copy of the user's login (`auth_kv` and the sign-in `state` keys), so sessions (`~/.kiro/sessions`), prompt history, logs and the extracted agent runtime are written only inside the trial; pinned to the sandbox agent `.kiro/agents/cad-eval.json` (V3 format: capability `permissions`, cad skills as `skill://` resources); `--trust-all-tools`, because a headless run treats every `ask` as a deny ([permissions](https://kiro.dev/docs/permissions.md)) and V3 `--trust-tools` matches exact V3 tool ids only, not the CLI 2.x names ([headless mode](https://kiro.dev/docs/cli/headless.md), [CLI commands](https://kiro.dev/docs/reference/cli-commands.md)); cad copied to `<work>/cad` | the turn's stream: final mode, final command list, context files, memory and MCP use | clean: mode `cad-eval`, the cad skills and reviewers, no steering, no memory. List Directory on the workspace root completed. The user's `~/.kiro` was unchanged; in the user's database only `extracted_kas_versions` changed, which the user's running Kiro rewrites twice a minute with no trial running (`smoke/kiro-store-control.json`); no row names the trial. The first attempt (`smoke/kiro-attempts.json`), with `--trust-tools=fs_read,…`, failed List Directory headless |
| OpenCode 2.1.4 | HOME, `XDG_*` and `TMPDIR` in the trial; `--standalone` (a private server in the trial's environment, not the shared background service); cad skills and agents in `<work>/.opencode/` | `opencode api --standalone` after the turn (instruction entries, plugins, MCP, config sources) plus OpenCode's documented skill and agent directories on disk. Its API skill and agent lists stay empty in a standalone server, so they are not used | clean: the cad skills and reviewers, no instructions or config outside the trial. The native libraries Bun extracts at startup (`.bun-<uid>-<hash>.dylib`, `.node`) and OpenCode's `opencode/` temp dir landed in the trial, not in the shared `$TMPDIR` |

**Claude Code's bundled components.** The adapter sets every documented switch that removes a bundled skill, subagent or command (`BUNDLED_OFF` in `adapters/claude.py`): `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS` (the env form of [`disableBundledSkills`](https://code.claude.com/docs/en/settings-reference#disablebundledskills), added in 2.1.169: bundled skills and workflows go), `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` (every built-in subagent type in `-p` mode, `general-purpose` included; [sub-agents](https://code.claude.com/docs/en/sub-agents)), `CLAUDE_CODE_DISABLE_WORKFLOWS`, `CLAUDE_CODE_DISABLE_POLICY_SKILLS`, and the `DISABLE_*_COMMAND` variables for `/doctor`, `/feedback`, `/usage-credits`, `/install-github-app`, `/login`, `/logout` and `/upgrade` ([env vars](https://code.claude.com/docs/en/env-vars)). The two `@builtin` plugins only have `enabledPlugins`. `--disable-slash-commands` is not used because it also removes the cad skills ([CLI reference](https://code.claude.com/docs/en/cli-reference)), and `DISABLE_COMPACT` is not used because it turns compaction off, not just the command. What remains are 28 built-in commands (`/clear`, `/compact`, `/model`, `/init`, …). No supported switch removes them; with bundled skills off they "stay typable but are hidden from the model" ([settings reference](https://code.claude.com/docs/en/settings-reference#disablebundledskills)). They are the declared baseline for 2.1.310 and are recorded in every row's `inventory.baseline`. A Claude Code update has to be re-observed before its rows count as clean.

**Host effects.** `run.py smoke` snapshots the shared temp directories (`$TMPDIR` and `/tmp`, two levels deep) and the harness's user stores (Kiro: `~/Library/Application Support/kiro-cli` and `~/.kiro`, with per-table row counts and digests of every SQLite file) before staging and after cleanup. It records what the harness wrote to the trial's own `TMPDIR`, attributes shared-temp additions to the trial when their path names the trial (Claude slugs the work dir) or matches a name in the trial's `TMPDIR`, lists every other addition as a concurrent process's, and reports added, removed or changed store entries, changed tables and rows that mention the trial. `host.unchanged` is strict, so a user's Kiro running beside the smoke makes it false; compare with `smoke/kiro-store-control.json`.

Residue: OMP, Kiro and OpenCode report no version in their inventory, so their baselines (OMP's bundled agents and commands; none for Kiro and OpenCode) are not checked against the running version. A Kiro trial that outlives the copied access token refreshes it inside its own copy only; the user's database keeps its token, and the user's Kiro refreshes that one itself.

## Adapters

| Harness | argv (first turn; later turns add the continue flag) | Served model read from | Usage read from |
|---|---|---|---|
| OMP | `omp -p --model M --mode json --no-title --auto-approve --plugin-dir P --session-dir S` (`--continue`) | `message_end` assistant `model` | assistant `usage` (+ `cost.total`) |
| Claude Code | `<real claude> -p --model <canonical> --output-format stream-json --verbose --permission-mode bypassPermissions --strict-mcp-config --mcp-config <empty> --setting-sources project,local --settings <trial json> --plugin-dir P` (`--continue`) | main-thread `assistant.message.model` (the bare id, e.g. `claude-haiku-5-5`) | `result.usage`, `total_cost_usd` |
| Kiro | `kiro-cli chat --no-interactive --agent-engine v3 --model M --output-format stream-json --trust-all-tools --trust-workspace --agent cad-eval` (`--resume`) | the `model` entry of the last `config_option_update` (the session's model setting; nothing closer to the wire is in the stream) | `promptTurnSummaries` credits; Kiro reports no tokens |
| OpenCode | `opencode run --standalone --model M --format json --auto` (`--continue`) | the session's assistant messages via `opencode api --standalone session.message.list` (the stream has no model id) | the same messages' `tokens` and `cost` (the stream can end before the last `step_finish`) |

The runner passes `--plugin-dir` only when the staged plugin has what that harness loads. During a `run`, its absence is a `plugin_missing` error. The OpenCode binary resolves from `$OPENCODE_BIN`, then `PATH` if it runs, then `~/.cache/.bun/bin/opencode`.

## Adding a case

1. Write `cases/<id>.case.json` against `cases/case.schema.json`. Put the stratum first in `tags`.
2. Write `truth/<id>/truth.json` from the specification, not from any model's output, and record its provenance.
3. Add `truth/<id>/oracle/`, the reference answer. Its `model.py` follows the cad-model part contract (`KERNEL`, `PARAMS`, `build`) and, run directly, writes the STEP next to itself. It also carries the record changes the task asks for (the BOM row), so seed plus oracle validates.
4. Run the pre-flight tests. The oracle must grade 1.0 and the seed alone 0.0.

Pick a case because someone can say why it is hard, never because today's model fails it. A ratchet flow needs 15–100 cases; the three seed cases are enough for the pilot and the pre-flight tests only.
