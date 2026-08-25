# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""lang-ts — TypeScript language overlay (Tier-2 stack resolver).

Ports setup-ts.sh (220 lines) to a native-root Python module, upgraded with
a Tier-2 agent resolver step that decides the fully-pinned stack.

Steps:
  resolve  (agent)  — Tier-2 agent maps prose intent → framework + pinned deps
  pins     (gate)   — shows the frozen pin table; user confirms before any write
  write    (python) — reads frozen pins from plan, verifies against npm,
                      writes package.json + dev tooling, appends .gitignore +
                      pre-commit hooks

Pin verification (init mode only, FR-005/FR-012):
  - PIN_DISCONFIRMED → hard error, write nothing
  - PIN_UNREACHABLE  → safe-skip the manifest write, emit warning (not error)
  - PIN_VERIFIED     → proceed

Reproduce mode: zero network — verification is skipped entirely (FR-009); the
pins were verified at init and the decision is replayed from answers.toml.

External tool absence/failure is NON-FATAL: a warning is emitted and the
module continues.  This mirrors the legacy WARN pattern in setup-ts.sh.

Invoked by the runner as:
    uv run module.py --plan <frozen_plan.json> --step write [--inspect]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

_TEMPLATES = Path(__file__).resolve().parent / "templates"

# Allowed template_id enum values (FR-002, SC-009).
_ALLOWED_TEMPLATE_IDS: frozenset[str] = frozenset({
    "vitest-node",
    "vitest-browser",
    "bun-test",
    "playwright-only",
    "vitest-node+playwright",
    "none",
})

# Allowed ui_kit_init_command prefixes (FR-008, SC-010, OQ-4 v1 allowlist).
# nuxt-ui entries deferred with nuxt-ui (OQ-2).
_UI_KIT_ALLOWLIST: tuple[str, ...] = (
    "npx shadcn",
    "bunx shadcn",
    "pnpm dlx shadcn",
)

# packageManager pin shape: name@MAJOR.MINOR.PATCH[optional prerelease/build].
# Rejects bare names, "latest", and ranges (FR-013, Decision D, SC-007).
_PM_PIN_RE = re.compile(
    r"[a-z@][a-z0-9._/@-]*@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]*)?"
)


def _load_sdk():
    """Load the runner SDK. Fast path: `import sdk` (the executor puts the runner
    dir on PYTHONPATH — spec 005). Fallback: load by file path for direct
    invocation outside the executor (e.g. functional tests)."""
    try:
        import sdk  # noqa: PLC0415
        return sdk
    except ModuleNotFoundError:
        pass
    # Fallback: locate sdk.py by path (PLUGIN_ROOT, or __file__-relative).
    plugin_root = os.environ.get("PLUGIN_ROOT") or os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        sdk_path = Path(plugin_root) / "runner" / "sdk.py"
        if not sdk_path.is_file():
            sdk_path = Path(plugin_root) / "skills" / "project-setup" / "runner" / "sdk.py"
    else:
        sdk_path = Path(__file__).resolve().parents[3] / "skills" / "project-setup" / "runner" / "sdk.py"
    spec = importlib.util.spec_from_file_location("sdk", sdk_path)
    assert spec and spec.loader, f"cannot locate runner SDK at {sdk_path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdk"] = mod          # register BEFORE exec_module (the @dataclass(Exception) footgun)
    spec.loader.exec_module(mod)
    return mod
def _pkg_cmd(pkg_manager: str, *sub: str) -> list[str]:
    """Build a package-manager command list (bun or pnpm)."""
    return [pkg_manager, *sub]


def _pkgx_cmd(pkg_manager: str, *sub: str) -> list[str]:
    """Build a package-manager exec command (bunx or pnpm dlx)."""
    if pkg_manager == "bun":
        return ["bunx", *sub]
    return ["pnpm", "dlx", *sub]


# --------------------------------------------------------------------------- #
# package.json dep-merging helpers (stdlib json only)                          #
# --------------------------------------------------------------------------- #

def _split_npm_pin(pin: str) -> tuple[str, str]:
    """Split ``name@version`` → (name, version). Handles scoped ``@scope/pkg@X.Y.Z``
    by splitting on the LAST ``@``. Returns (pin, "") if there is no version."""
    s = str(pin).strip()
    at = s.rfind("@")
    if at <= 0:
        return s, ""
    return s[:at], s[at + 1:]


def _patch_package_json(
    pkg_json_path: Path,
    pinned_deps: list[str],
    dev_deps: list[str],
    package_manager_pin: str,
    warnings: list[str],
    *,
    engines: dict[str, str] | None = None,
) -> bool:
    """Write merged runtime + dev deps into package.json.

    Strategy: read existing (if any), merge ``dependencies`` from pinned_deps
    and ``devDependencies`` from dev_deps (name→version, sorted keys), set the
    top-level ``packageManager`` field from package_manager_pin.  Writes with
    ``json.dumps(..., indent=2, sort_keys=True) + "\\n"`` for byte-stable
    determinism (Tier-1 guarantee: same answers → byte-identical output).

    The optional *engines* keyword parameter (FR-014) additively merges the
    provided dict into ``package.json["engines"]`` (sorted keys). Existing
    callers that do not pass *engines* are unaffected (additive, keyword-only).

    Returns True if the file was written.  Never raises.
    """
    try:
        if pkg_json_path.exists():
            data = json.loads(pkg_json_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        else:
            data = {}

        # Merge runtime deps into data["dependencies"]
        existing_deps: dict[str, str] = dict(data.get("dependencies") or {})
        for pin in pinned_deps:
            name, version = _split_npm_pin(pin)
            if name and version:
                existing_deps[name] = version
        # Sort for determinism
        data["dependencies"] = dict(sorted(existing_deps.items()))

        # Merge dev deps into data["devDependencies"]
        existing_dev: dict[str, str] = dict(data.get("devDependencies") or {})
        for pin in dev_deps:
            name, version = _split_npm_pin(pin)
            if name and version:
                existing_dev[name] = version
        data["devDependencies"] = dict(sorted(existing_dev.items()))

        # Set packageManager field
        if package_manager_pin:
            data["packageManager"] = package_manager_pin

        # Merge engines (FR-014/015, keyword-only, additive).
        if engines:
            existing_engines: dict[str, str] = dict(data.get("engines") or {})
            existing_engines.update(engines)
            data["engines"] = dict(sorted(existing_engines.items()))

        pkg_json_path.write_text(
            json.dumps(data, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return True
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"WARN: could not patch package.json: {exc}")
        return False


def _patch_pins_into_package_json(
    sdk, project_dir, pinned_deps, dev_deps, package_manager_pin,
    diffs, files_written, warnings, *, inspect: bool,
    engines: dict[str, str] | None = None,
) -> None:
    """Merge the frozen pins into package.json (idempotent; safe to call twice).

    Called once in the deterministic ``write`` step and again after the external
    generator runs in ``scaffold`` (the generator may have --force-overwritten
    package.json, dropping the pins — re-merging restores the frozen decision).

    The optional *engines* keyword argument (FR-014) is passed through to
    ``_patch_package_json`` for node-runtime engine constraints. Scaffold
    re-merge calls this without *engines* (default None) — behaviour unchanged.
    """
    any_pins = bool(pinned_deps or dev_deps or package_manager_pin)
    if not any_pins:
        return
    if inspect:
        diffs.append(sdk.Diff(
            path="package.json",
            kind="modify",
            preview=(
                f"(would write {len(pinned_deps)} runtime pins + {len(dev_deps)} dev pins"
                + (f", packageManager={package_manager_pin!r}" if package_manager_pin else "")
                + ")"
            ),
        ))
        return
    patched = _patch_package_json(
        project_dir / "package.json",
        pinned_deps=list(pinned_deps),
        dev_deps=list(dev_deps),
        package_manager_pin=package_manager_pin,
        warnings=warnings,
        engines=engines,
    )
    if patched:
        if "package.json" not in files_written:
            files_written.append("package.json")
        diffs.append(sdk.Diff(
            path="package.json",
            kind="modify",
            preview=(
                f"(pinned deps written: {len(pinned_deps)} runtime, "
                f"{len(dev_deps)} dev, packageManager={package_manager_pin!r})"
            ),
        ))


# --------------------------------------------------------------------------- #
# Step handlers                                                                #
# --------------------------------------------------------------------------- #

def _do_write(sdk, inputs, args) -> int:
    """write step: verify pins (init only), then write package.json + tooling."""
    pkg_manager: str = inputs.get_choice("package_manager", default="bun")
    framework: str = inputs.get_str("framework", default="plain") or "plain"
    pinned_deps: list[str] = inputs.get_list("pinned_deps", default=[])
    dev_deps: list[str] = inputs.get_list("dev_deps", default=[])
    package_manager_pin: str = inputs.get_str("package_manager_pin", default="")
    template_id: str = inputs.get_str("template_id", default="none") or "none"
    runtime: str = inputs.get_str("runtime", default="bun") or "bun"
    node_line: str = inputs.get_str("node_line", default="")
    # Package identity: prefer the explicit project_name answer; fall back to
    # the directory name when absent (preserves existing behaviour for answer-
    # less runs). bun/pnpm init don't accept a name flag reliably, so we
    # post-patch package.json "name" after the init tool runs.
    raw_name = inputs.get_str("project_name", default="")


    # Normalize framework to known values; treat unknowns as "plain"
    if framework not in ("nuxt", "vite", "plain", "sst"):
        warnings_pre: list[str] = [
            f"WARN: unknown framework '{framework}' — treating as 'plain'"
        ]
        framework = "plain"
    else:
        warnings_pre = []

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = list(warnings_pre)
    diffs = []
    files_written: list[str] = []

    # ── PM pin shape validation (FR-013, Decision D, SC-007) ──────────────── #
    # Must reject "bun@latest", bare "bun", and ranges like "^1.0.0".
    if package_manager_pin and not re.fullmatch(_PM_PIN_RE, package_manager_pin):
        error = sdk.SetupError(
            error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
            module_id="lang-ts",
            expected="packageManager pin in name@MAJOR.MINOR.PATCH format",
            received=repr(package_manager_pin),
            how_to_fix=(
                f"package_manager_pin {package_manager_pin!r} is not a valid exact "
                "semver pin. Use name@X.Y.Z (no 'latest', no ranges). "
                "Re-run with --refresh lang-ts to let the agent correct it."
            ),
        )
        sdk.emit_result(sdk.ModuleResult(
            module_id="lang-ts", step_id=args.step, status="error",
            files_written=[], diffs=[], warnings=warnings, error=error.to_dict(),
        ))
        return 1

    # ── PM/runtime consistency (FR-017, SC-008) ───────────────────────────── #
    # pkg_manager (interview choice) must agree with pin name prefix.
    if package_manager_pin:
        pin_name = package_manager_pin.split("@")[0] if "@" in package_manager_pin else package_manager_pin
        # For scoped packages (e.g. @foo/bar@1.2.3) the split at "@" gives "" for
        # the first element; use rfind-based split in that case.
        if not pin_name:
            # scoped: last @ separates version; everything before is the name
            at_idx = package_manager_pin.rfind("@")
            pin_name = package_manager_pin[:at_idx]
        if pin_name and pin_name != pkg_manager:
            error = sdk.SetupError(
                error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
                module_id="lang-ts",
                expected=f"package_manager_pin name to match package_manager ('{pkg_manager}')",
                received=repr(package_manager_pin),
                how_to_fix=(
                    f"package_manager='{pkg_manager}' but package_manager_pin "
                    f"starts with '{pin_name}'. They must agree. "
                    "Re-run with --refresh lang-ts to correct the mismatch."
                ),
            )
            sdk.emit_result(sdk.ModuleResult(
                module_id="lang-ts", step_id=args.step, status="error",
                files_written=[], diffs=[], warnings=warnings, error=error.to_dict(),
            ))
            return 1

    # ── template_id validation (FR-002/FR-003, SC-009) ────────────────────── #
    if template_id not in _ALLOWED_TEMPLATE_IDS:
        error = sdk.SetupError(
            error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
            module_id="lang-ts",
            expected=f"template_id in {sorted(_ALLOWED_TEMPLATE_IDS)}",
            received=repr(template_id),
            how_to_fix=(
                f"template_id {template_id!r} is not a recognised template. "
                "Re-run with --refresh lang-ts to let the agent correct it."
            ),
        )
        sdk.emit_result(sdk.ModuleResult(
            module_id="lang-ts", step_id=args.step, status="error",
            files_written=[], diffs=[], warnings=warnings, error=error.to_dict(),
        ))
        return 1

    # ── Pin verification (init mode only, FR-005/FR-012) ───────────────────── #
    # Include package_manager_pin in the verify batch (it is also a name@version)
    all_pins = list(pinned_deps) + list(dev_deps)
    if package_manager_pin:
        all_pins = all_pins + [package_manager_pin]

    if all_pins and inputs.mode == "init":
        verify_result = sdk.verify_pins(all_pins, "npm")

        bad_pins = [p for p, s in verify_result.items() if s == sdk.PIN_DISCONFIRMED]
        if bad_pins:
            error = sdk.SetupError(
                error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
                module_id="lang-ts",
                expected="all pins to exist on npm",
                received=f"disconfirmed pins: {bad_pins}",
                how_to_fix=(
                    "The agent proposed pins that do not exist on npm: "
                    + ", ".join(bad_pins)
                    + ". Re-run with --refresh lang-ts to let the agent correct them."
                ),
            )
            result = sdk.ModuleResult(
                module_id="lang-ts",
                step_id=args.step,
                status="error",
                files_written=[],
                diffs=[],
                warnings=warnings,
                error=error.to_dict(),
            )
            sdk.emit_result(result)
            return 1

        unreachable_pins = [p for p, s in verify_result.items() if s == sdk.PIN_UNREACHABLE]
        if unreachable_pins:
            warnings.append(
                "WARN: registry unreachable for pins: "
                + ", ".join(unreachable_pins)
                + " — manifest write SKIPPED (safe-skip, FR-012). "
                "Restore network connectivity and re-run to write the manifest."
            )
            result = sdk.ModuleResult(
                module_id="lang-ts",
                step_id=args.step,
                status="ok",
                files_written=[],
                diffs=[sdk.Diff(
                    path="package.json",
                    kind="skip",
                    preview="(safe-skip: registry unreachable for some pins)",
                )],
                warnings=warnings,
            )
            sdk.emit_result(result)
            return 0

    # ── 1. tsconfig.json + src/ (deterministic, plain only) ────────────────── #
    # The external scaffolders (nuxi/create-vite) emit their own tsconfig, so this
    # deterministic tsconfig is the plain-framework baseline. The generators
    # themselves run in the SEPARATE, G4-gated `scaffold` step (spec 004 FR-013),
    # which is ordered AFTER this deterministic write so a declined generator gate
    # skips ONLY the scaffolder while these writes still land.
    if framework not in ("nuxt", "vite"):  # plain / sst / unknown-treated-as-plain
        tsconfig_body = (_TEMPLATES / "tsconfig.json").read_text(encoding="utf-8")
        diff = sdk.idempotent_write(
            "tsconfig.json",
            tsconfig_body,
            project_dir=project_dir,
            reconcile=False,
            inspect=args.inspect,
        )
        diffs.append(diff)
        if diff.kind in ("create", "modify"):
            files_written.append(diff.path)
            if not args.inspect:
                (project_dir / "src").mkdir(exist_ok=True)

    # ── 2. Write pinned deps into package.json (deterministic, FR-005/FR-012) ─ #
    # First-class deterministic action — independent of the scaffolder. For nuxt/
    # vite the generator may later --force-overwrite package.json; the scaffold
    # step re-merges these pins afterwards so the frozen decision is preserved.
    # Pass engines only for node runtime (FR-014/015): bun → no engines field.
    node_engines: dict[str, str] | None = None
    if runtime == "node" and node_line:
        node_engines = {"node": f">={node_line}"}
    _patch_pins_into_package_json(sdk, project_dir, pinned_deps, dev_deps,
                                  package_manager_pin, diffs, files_written,
                                  warnings, inspect=args.inspect,
                                  engines=node_engines)

    # ── 2a. Patch package.json "name" from the project_name answer ────────── #
    # _patch_pins_into_package_json only sets deps/packageManager/engines.
    # Explicitly set "name" here so the deterministic write step already reflects
    # the answer-driven identity before the external generator (scaffold step) runs.
    # bun/pnpm init default "name" to the directory name; override with the answer.
    project_name_for_write = raw_name.strip() if raw_name.strip() else project_dir.name
    if not args.inspect and project_name_for_write:
        pkg_json_path_w = project_dir / "package.json"
        if pkg_json_path_w.exists():
            try:
                _data_w = json.loads(pkg_json_path_w.read_text(encoding="utf-8"))
                if isinstance(_data_w, dict) and _data_w.get("name") != project_name_for_write:
                    _data_w["name"] = project_name_for_write
                    pkg_json_path_w.write_text(
                        json.dumps(_data_w, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    if "package.json" not in files_written:
                        files_written.append("package.json")
                    diffs.append(sdk.Diff(
                        path="package.json", kind="modify",
                        preview=f'(package.json "name" set to {project_name_for_write!r})',
                    ))
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"WARN: could not patch package.json name: {exc}")

    # ── 2b. Write .node-version (FR-014/015, SC-006) ──────────────────────── #
    # node runtime + non-empty node_line → .node-version with reconcile=False
    # (write-if-absent; existing .node-version is never overwritten).
    # bun runtime → skip entirely (Bun manages its own version).
    if runtime == "node" and node_line:
        nv_diff = sdk.idempotent_write(
            ".node-version",
            f"{node_line}\n",
            project_dir=project_dir,
            reconcile=False,
            inspect=args.inspect,
        )
        diffs.append(nv_diff)
        if nv_diff.kind in ("create", "modify"):
            files_written.append(nv_diff.path)

    # ── 2c. Test-runner template instantiation (FR-003, SC-001/SC-002) ──────── #
    # Write each file in templates/<template_id>/ verbatim (idempotent, reconcile=True).
    # "none" → no config files written.
    if template_id != "none":
        template_dir = _TEMPLATES / template_id
        for tpl_file in sorted(template_dir.iterdir()):
            if not tpl_file.is_file():
                continue
            content = tpl_file.read_text(encoding="utf-8")
            tpl_diff = sdk.idempotent_write(
                tpl_file.name,
                content,
                project_dir=project_dir,
                reconcile=True,
                inspect=args.inspect,
            )
            diffs.append(tpl_diff)
            if tpl_diff.kind in ("create", "modify"):
                files_written.append(tpl_diff.path)

    # ── 4. Append Node .gitignore block ────────────────────────────────────── #
    gitignore = project_dir / ".gitignore"
    gi_block = (_TEMPLATES / "gitignore-block.txt").read_text(encoding="utf-8")
    if not args.inspect:
        appended = sdk.append_if_absent(
            gitignore, "node_modules", gi_block, warnings, "Node .gitignore"
        )
        if appended:
            files_written.append(".gitignore")
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(Node gitignore block appended)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(node_modules already present)"))
    else:
        existing_gi = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
        if "node_modules" not in existing_gi:
            diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(would append Node gitignore block)"))
        else:
            diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(node_modules already present)"))

    # ── 5. Framework-specific .gitignore extras ─────────────────────────────── #
    if framework == "nuxt":
        nuxt_gi_block = (_TEMPLATES / "gitignore-nuxt.txt").read_text(encoding="utf-8")
        if not args.inspect:
            appended = sdk.append_if_absent(
                gitignore, ".nitro", nuxt_gi_block, warnings, "Nuxt .gitignore extras"
            )
            if appended:
                if ".gitignore" not in files_written:
                    files_written.append(".gitignore")
                diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(Nuxt extras appended)"))
            else:
                diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(.nitro already present)"))
        else:
            existing_gi2 = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
            if ".nitro" not in existing_gi2:
                diffs.append(sdk.Diff(path=".gitignore", kind="modify", preview="(would append Nuxt gitignore extras)"))
            else:
                diffs.append(sdk.Diff(path=".gitignore", kind="skip", preview="(.nitro already present)"))

    # ── 6. Append biome pre-commit hook ────────────────────────────────────── #
    precommit = project_dir / ".pre-commit-config.yaml"
    biome_block = (_TEMPLATES / "precommit-biome.yaml").read_text(encoding="utf-8")
    prettier_block = (_TEMPLATES / "precommit-prettier.yaml").read_text(encoding="utf-8")
    if precommit.exists():
        if not args.inspect:
            appended = sdk.append_if_absent(
                precommit, "biomejs/pre-commit", biome_block, warnings, "biome pre-commit hook"
            )
            if appended:
                files_written.append(".pre-commit-config.yaml")
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(biome hook appended)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(biome hook already present)"))

            # ── 7. Append prettier pre-commit hook ──────────────────────────── #
            appended2 = sdk.append_if_absent(
                precommit, "rbubley/mirrors-prettier", prettier_block, warnings, "prettier pre-commit hook"
            )
            if appended2:
                if ".pre-commit-config.yaml" not in files_written:
                    files_written.append(".pre-commit-config.yaml")
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(prettier hook appended)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(prettier hook already present)"))
        else:
            existing_pc = precommit.read_text(encoding="utf-8")
            if "biomejs/pre-commit" not in existing_pc:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(would append biome hook)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(biome hook already present)"))
            if "rbubley/mirrors-prettier" not in existing_pc:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="modify", preview="(would append prettier hook)"))
            else:
                diffs.append(sdk.Diff(path=".pre-commit-config.yaml", kind="skip", preview="(prettier hook already present)"))
    else:
        diffs.append(sdk.Diff(
            path=".pre-commit-config.yaml",
            kind="skip",
            preview="(.pre-commit-config.yaml absent — run precommit-setup first)",
        ))

    result = sdk.ModuleResult(
        module_id="lang-ts",
        step_id=args.step,
        status="ok",
        files_written=files_written,
        diffs=diffs,
        warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


def _do_scaffold(sdk, inputs, args) -> int:
    """scaffold step: run the external framework generator + pkg install (G4).

    Separated from ``write`` (spec 004 FR-013) so the soft G4 gate can skip JUST
    the external-generator run (network + may --force-overwrite files) while the
    deterministic ``write`` step's pinned package.json / tsconfig already landed.
    A declined G4 gate (gate-blocked) skips this step entirely; CI runs it unless
    --no-external-generators is passed. After the generator runs we RE-MERGE the
    frozen pins (the generator may have clobbered package.json).
    """
    pkg_manager: str = inputs.get_choice("package_manager", default="bun")
    framework: str = inputs.get_str("framework", default="plain") or "plain"
    pinned_deps: list[str] = inputs.get_list("pinned_deps", default=[])
    dev_deps: list[str] = inputs.get_list("dev_deps", default=[])
    package_manager_pin: str = inputs.get_str("package_manager_pin", default="")
    if framework not in ("nuxt", "vite", "plain", "sst"):
        framework = "plain"

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # Package identity (mirrors write step): prefer project_name answer; fall
    # back to dir name. bun/pnpm init don't take a name flag reliably, so we
    # post-patch package.json "name" after the init tool runs.
    raw_name = inputs.get_str("project_name", default="")
    project_name = raw_name.strip() if raw_name.strip() else project_dir.name

    # ── External framework generator (network; may --force-overwrite) ──────── #
    if framework == "nuxt":
        if not (project_dir / "nuxt.config.ts").exists():
            if not args.inspect:
                sdk.run_tool(
                    _pkgx_cmd(pkg_manager, "nuxi@latest", "init", ".", "--force",
                              "--packageManager", pkg_manager),
                    cwd=project_dir, warnings=warnings, label="nuxi init", timeout=180,
                )
            else:
                warnings.append(f"inspect: would run nuxi@latest init . --force --packageManager {pkg_manager}")
        else:
            diffs.append(sdk.Diff(path="nuxt.config.ts", kind="skip", preview="(Nuxt already scaffolded)"))
    elif framework == "vite":
        if not (project_dir / "vite.config.ts").exists():
            if not args.inspect:
                sdk.run_tool(
                    _pkgx_cmd(pkg_manager, "create-vite", ".", "--template", "vue-ts"),
                    cwd=project_dir, warnings=warnings, label="create-vite vue-ts", timeout=180,
                )
            else:
                warnings.append("inspect: would run create-vite . --template vue-ts")
        else:
            diffs.append(sdk.Diff(path="vite.config.ts", kind="skip", preview="(Vite already scaffolded)"))
    else:  # plain / sst
        package_json = project_dir / "package.json"
        if not package_json.exists():
            if not args.inspect:
                if pkg_manager == "bun":
                    sdk.run_tool(["bun", "init", "-y"], cwd=project_dir, warnings=warnings, label="bun init", timeout=180)
                else:
                    sdk.run_tool(["pnpm", "init"], cwd=project_dir, warnings=warnings, label="pnpm init", timeout=180)
            else:
                warnings.append(f"inspect: would run {pkg_manager} init")
        else:
            diffs.append(sdk.Diff(path="package.json", kind="skip", preview="(package.json already exists)"))

    # ── Post-init: patch package.json "name" from the answer ──────────────── #
    # bun init and pnpm init name the package after the directory, not the
    # project_name answer. Patch "name" (and "description" if present as a
    # placeholder) so the published package name matches the frozen identity.
    if not args.inspect and project_name:
        pkg_json_path = project_dir / "package.json"
        if pkg_json_path.exists():
            try:
                data = json.loads(pkg_json_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    changed = False
                    if data.get("name") != project_name:
                        data["name"] = project_name
                        changed = True
                    if changed:
                        pkg_json_path.write_text(
                            json.dumps(data, indent=2, sort_keys=True) + "\n",
                            encoding="utf-8",
                        )
                        if "package.json" not in files_written:
                            files_written.append("package.json")
                        diffs.append(sdk.Diff(
                            path="package.json",
                            kind="modify",
                            preview=f'(package.json "name" set to {project_name!r})',
                        ))
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"WARN: could not patch package.json name: {exc}")

    # ── Re-merge frozen pins (the generator may have clobbered package.json) ── #
    _patch_pins_into_package_json(sdk, project_dir, pinned_deps, dev_deps,
                                  package_manager_pin, diffs, files_written,
                                  warnings, inspect=args.inspect)

    # ── pkg install (non-fatal, skipped under inspect) ─────────────────────── #
    if not args.inspect:
        sdk.run_tool(
            _pkg_cmd(pkg_manager, "install"),
            cwd=project_dir, warnings=warnings, label=f"{pkg_manager} install", timeout=180,
        )

    result = sdk.ModuleResult(
        module_id="lang-ts", step_id=args.step, status="ok",
        files_written=files_written, diffs=diffs, warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


def _do_ui_kit_scaffold(sdk, inputs, args) -> int:
    """ui-kit-scaffold step: gate-guarded, non-idempotent UI-kit init command (FR-008).

    This step is called by the runner only when the preceding ``ui-kit-init`` gate
    returned True (confirmed/allowed). However, for the ``init_only`` gate the
    runner auto-proceeds on plain reproduce (reproduce.apply init_only_bypass),
    which means this step IS called on reproduce — but MUST NOT re-run the init
    command (non-idempotent clobber risk, FR-010).

    Execute-vs-safe-skip decision (gate-outcome detection rationale):
    - When mode == "init": the gate was either confirmed by the user (TTY +
      --allow-ui-kit-init) OR the runner blocked the step via gate_blocked=True
      in which case this function is never called at all. So mode=="init" reliably
      means "gate was confirmed — execute".
    - When mode != "init" (reproduce/refresh): the init_only gate auto-proceeded,
      but running the init command again would clobber already-scaffolded files.
      Safe-skip and write a STACK-NOTES.md reminder.

    NOTE: In the non-interactive CI path without --allow-ui-kit-init the hard gate
    returns False → gate_blocked=True → this step is skipped by the runner entirely
    (reproduce.apply continues past it). The STACK-NOTES note in that path is NOT
    written by this function — the caller (runner) skips us. If CI-path STACK-NOTES
    is needed, a future enhancement can add a gate-decline side-effect to the runner.
    For now, the spec's SC-003 CI safe-skip path is covered by the runner's own skip.
    """
    ui_kit_id: str = inputs.get_str("ui_kit_id", default="none") or "none"
    ui_kit_init_command: str = inputs.get_str("ui_kit_init_command", default="")

    project_dir_env = os.environ.get("PROJECT_DIR")
    project_dir = Path(project_dir_env).resolve() if project_dir_env else Path.cwd().resolve()

    warnings: list[str] = []
    diffs = []
    files_written: list[str] = []

    # ── FR-011 / SC-012: ui_kit_id == "none" → clean no-op ──────────────── #
    if ui_kit_id == "none":
        result = sdk.ModuleResult(
            module_id="lang-ts", step_id=args.step, status="ok",
            files_written=[], diffs=[sdk.Diff(
                path="ui-kit-scaffold",
                kind="skip",
                preview="(ui_kit_id=none — no UI kit init required)",
            )],
            warnings=[],
        )
        sdk.emit_result(result)
        return 0

    # ── Allowlist validation (FR-008, SC-010) ────────────────────────────── #
    if not any(ui_kit_init_command.startswith(prefix) for prefix in _UI_KIT_ALLOWLIST):
        error = sdk.SetupError(
            error_code=sdk.ErrorCode.INPUT_VALUE_INVALID,
            module_id="lang-ts",
            expected=f"ui_kit_init_command starting with one of {list(_UI_KIT_ALLOWLIST)}",
            received=repr(ui_kit_init_command),
            how_to_fix=(
                f"ui_kit_init_command {ui_kit_init_command!r} is not in the allowed "
                "prefix list. Re-run with --refresh lang-ts to let the agent correct it."
            ),
        )
        sdk.emit_result(sdk.ModuleResult(
            module_id="lang-ts", step_id=args.step, status="error",
            files_written=[], diffs=[], warnings=warnings, error=error.to_dict(),
        ))
        return 1

    # ── Safe-skip on reproduce (FR-009/010, SC-005) ───────────────────────── #
    # The init_only gate auto-proceeds on reproduce (init_only_bypass=True),
    # meaning this step IS called. We must not re-run the non-idempotent command.
    # Only execute when mode == "init" (gate was explicitly confirmed this run).
    if inputs.mode != "init":
        # Append a STACK-NOTES.md reminder (idempotent — command string is marker).
        stack_notes_path = project_dir / "STACK-NOTES.md"
        note_block = (
            f"\n## UI-kit init (manual step)\n\n"
            f"The UI-kit init command was NOT re-run on reproduce (non-idempotent).\n"
            f"To re-initialize, run:\n\n"
            f"    {ui_kit_init_command}\n\n"
            f"Or re-run project-setup with `--refresh lang-ts` to re-trigger the gate.\n"
        )
        if not args.inspect:
            sdk.append_if_absent(
                stack_notes_path, ui_kit_init_command, note_block, warnings, "ui-kit-scaffold note"
            )
            files_written.append("STACK-NOTES.md")
        diffs.append(sdk.Diff(
            path="STACK-NOTES.md",
            kind="modify",
            preview=f"(safe-skip: ui-kit init is non-idempotent on reproduce; note appended: {ui_kit_init_command!r})",
        ))
        result = sdk.ModuleResult(
            module_id="lang-ts", step_id=args.step, status="ok",
            files_written=files_written if not args.inspect else [],
            diffs=diffs, warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    # ── Execute (init + gate confirmed) ──────────────────────────────────── #
    if args.inspect:
        diffs.append(sdk.Diff(
            path="ui-kit-scaffold",
            kind="create",
            preview=f"(would run: {ui_kit_init_command})",
        ))
        result = sdk.ModuleResult(
            module_id="lang-ts", step_id=args.step, status="ok",
            files_written=[], diffs=diffs, warnings=warnings,
        )
        sdk.emit_result(result)
        return 0

    cmd_parts = ui_kit_init_command.split()
    sdk.run_tool(cmd_parts, cwd=project_dir, warnings=warnings, label="ui-kit init", timeout=180)

    diffs.append(sdk.Diff(
        path="ui-kit-scaffold",
        kind="create",
        preview=f"(ran: {ui_kit_init_command})",
    ))
    result = sdk.ModuleResult(
        module_id="lang-ts", step_id=args.step, status="ok",
        files_written=files_written, diffs=diffs, warnings=warnings,
    )
    sdk.emit_result(result)
    return 0


STEP_HANDLERS = {
    "write": _do_write,
    "scaffold": _do_scaffold,
    "ui-kit-scaffold": _do_ui_kit_scaffold,
    # "resolve" is kind=agent — handled by the runner's Tier-2 agent subsystem.
    # "pins"/"run-generator"/"ui-kit-init" are kind=gate — handled by the runner's
    # gate subsystem.
}


def main() -> int:
    ap = argparse.ArgumentParser(description="lang-ts module")
    ap.add_argument("--plan", required=True, help="path to the frozen plan.json")
    ap.add_argument("--step", required=True, help="step id to run")
    ap.add_argument("--inspect", action="store_true", help="dry pass: preview, no write")
    args = ap.parse_args()

    handler = STEP_HANDLERS.get(args.step)
    if handler is None:
        print(
            f"Unknown step: {args.step!r}. "
            f"Python-handled steps: {list(STEP_HANDLERS)}. "
            f"Agent/gate steps are dispatched by the runner, not by module.py.",
            file=sys.stderr,
        )
        return 1

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="lang-ts")
    return handler(sdk, inputs, args)


if __name__ == "__main__":
    raise SystemExit(main())
