# Ecosystem License Norms

Reference data for validating recommendations against real-world conventions.
Updated 2026-07.

## Rust (crates.io)

- **Dominant**: MIT OR Apache-2.0 (dual-license is the cargo-new default)
- **Accepted**: MPL-2.0 (Firefox components, resvg, option-ext -- used in production)
- **Tolerated**: LGPL (but treated as GPL by community due to static linking; effectively avoided)
- **Avoided**: GPL, AGPL (dependency-level only; fine for applications)
- **Tooling**: `cargo-deny` has no built-in allowlist; users configure their own. MPL triggers the same "not in my list" error as any non-configured license -- one-line fix.
- **Static linking**: Rust compiles everything statically. LGPL's relink requirement is impractical. MPL's file boundary is unaffected.
- **Monomorphization**: generics inline across crate boundaries. Legal status under LGPL unclear. MPL unaffected (file boundary).

## Python (PyPI)

- **Dominant**: MIT, BSD-3-Clause, Apache-2.0
- **Accepted**: LGPL, MPL (no linking concept in Python; both work fine)
- **Corporate**: MIT/Apache auto-approved; anything else triggers review
- **No linking concerns**: Python is interpreted; no static/dynamic split

## TypeScript / JavaScript (npm)

- **Dominant**: MIT (overwhelming majority)
- **Accepted**: Apache-2.0, ISC, BSD
- **Corporate**: MIT auto-approved; even Apache sometimes triggers review
- **Note**: npm ecosystem is extremely MIT-biased; any non-MIT license is friction

## Go

- **Dominant**: BSD-3-Clause, MIT, Apache-2.0
- **Accepted**: MPL-2.0 (HashiCorp used it extensively pre-BSL switch)
- **Static linking**: Go compiles statically like Rust. Same LGPL concerns apply.
- **Note**: HashiCorp's MPL→BSL switch caused backlash but demonstrated MPL was accepted in production Go code for years.

## C / Embedded

- **Dominant**: MIT, BSD, Apache-2.0 for libraries; GPL for applications
- **Critical constraint**: no dynamic linker on most MCUs (ESP32, STM32, nRF). LGPL relink requirement is physically impossible to fulfill.
- **MPL**: works fine (file boundary is hardware-agnostic)
- **Corporate embedded**: many shops have strict no-copyleft policies for firmware. GPL/AGPL = hard no for commercial embedded. MPL = usually accepted after legal review.

## General observations

- cargo-deny / license-checker / FOSSA / Snyk all use SPDX identifiers and allowlists. No tool has a built-in "green tier" -- every license must be explicitly approved.
- The friction of non-MIT/Apache licenses is primarily HUMAN (policy review, unfamiliarity) not TOOLING (one-line config edit).
- Ecosystem dominance ≠ technical superiority. MIT dominates because it's the path of least resistance for package authors, not because it's optimal for maintainers.
