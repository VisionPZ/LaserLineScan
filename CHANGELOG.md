<!--
  SPDX-License-Identifier: GPL-3.0-or-later
  Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
-->

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A project front page ([`README.md`](README.md)) covering quick start,
  features, layout, documentation, testing, browser support and the licence,
  and a rewritten [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Unit tests under `tests/unit/` and static integration tests under `tests/`,
  run by `npm test`, plus the Playwright browser probe `tests/smoke.py`.
- A CI `integration` job that runs the browser probe on `main` and on manual
  dispatch (the `test` job still runs the Node suite and the licence-header
  gate on every push and pull request).

### Changed

- Documentation and test-infrastructure pass: no runtime behaviour change.
- The prebuilt demo dataset under `demo/` (33 MB) ships with the package so the
  demo runs without the multi-gigabyte HD capture tree.

## [1.0.0] - 2026-09-20

### Added

- **Five-step browser wizard** for the whole laser-perception pipeline:
  00 optics, 01 rig, 02 calibration, 03 object scan and 04 dense 3D result.
- **Spectral design** — model the laser, lens band-pass filter, ambient
  illumination and sensor response, with live spectrum and RGB plots.
- **Calibration** — ChArUco board detection, camera intrinsics and distortion,
  board pose, laser-plane fitting and the affine command-to-plane map.
- **Dense reconstruction** — per-frame sub-pixel stripe extraction over the full
  sensor (colour and monochrome), triangulation to a 3D point cloud, an
  interactive viewer and PLY/JSON export.
- **Open WebAssembly kernel** (`assembly/laser/oss.ts` → `runtime/core.wasm`)
  for extraction and calibration, running in a Web Worker.
- **Licence** — released under **GPL-3.0-or-later** with an additional
  attribution term under GPLv3 section 7(b); see [`LICENSE`](LICENSE) and
  [`NOTICE`](NOTICE). Commercial use is permitted under the same terms.

[Unreleased]: https://github.com/VisionPZ/LaserLineScan/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/VisionPZ/LaserLineScan/releases/tag/v1.0.0
