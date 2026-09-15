<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com> -->

# laser-scan design documentation

This directory documents the design of **laser-scan**, the browser-only
structured-light laser scanner. Every page here is derived from the shipped
runtime modules (`../runtime/*.js`), the compiled AssemblyScript kernel
(`../runtime/core.wasm`) and the upstream reference documents
(`docs/LASER-CALIBRATION.md`, `docs/LASER-UI-AUDIT.md` and
`public/laser/DATASET-CARD.md` in the parent Nidvue website repository).
Numbers are quoted only where the code or those documents state them, and the
source is named next to each one.

The scanner runs entirely in the page: the frames, the calibration and the
point cloud never leave the browser. The package root has its own
[`README.md`](../README.md) for installation, and
[`COMMERCIAL-USE.md`](COMMERCIAL-USE.md) explains the GPL-3.0-or-later licence
and the additional attribution term.

## Index

| Document | One-line summary |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The whole system: the five-step wizard, the module map, the worker and WebAssembly boundaries, and where data lives. |
| [OPTICS-MODEL.md](OPTICS-MODEL.md) | Step 00: the wavelength grid, laser diodes, the lens bandpass and its angle shift, sensor QE, ambient sources, the derived stripe colour and contrast gain, and the editable control points. |
| [CALIBRATION.md](CALIBRATION.md) | Step 02: ChArUco detection and pose, camera intrinsics/distortion, the plane fit and the encoder model, ROI derivation, the calibration metrics and the Markdown/PowerPoint reports. |
| [SCAN-PIPELINE.md](SCAN-PIPELINE.md) | Step 03: frame shading, blue-excess row scoring, the learned row gate, the search band and out-of-band verification, scatter-tail recovery, triangulation and the coverage/error metrics. |
| [DATA-FORMATS.md](DATA-FORMATS.md) | The dataset layout, every manifest field that matters, frame naming and counts, truth volumes, `hd` versus `hd-mono`, and the PLY/JSON exports. |
| [RENDERING.md](RENDERING.md) | The viewer and the rig scene: engine fallbacks, point/mesh display, colour modes, orbit/pan/zoom presets, dimension rulers and fullscreen. |
| [TESTING.md](TESTING.md) | What the unit, integration and end-to-end suites cover, and the exact commands to run each. |
| [COMMERCIAL-USE.md](COMMERCIAL-USE.md) | Plain-language commercial-use and licence guidance (existing page). |

## Suggested reading order

1. [ARCHITECTURE.md](ARCHITECTURE.md) — get the shape of the system and the
   two process/engine boundaries.
2. [OPTICS-MODEL.md](OPTICS-MODEL.md) — the physics every later step renders
   and scans with.
3. [CALIBRATION.md](CALIBRATION.md) — how the rig is measured and the search
   ROI is derived.
4. [SCAN-PIPELINE.md](SCAN-PIPELINE.md) — how a scan turns frames into a point
   cloud and the numbers reported with it.
5. [DATA-FORMATS.md](DATA-FORMATS.md) — the on-disk contracts between the
   generator, the page and the exports.
6. [RENDERING.md](RENDERING.md) — how the results and the rig are drawn.
7. [TESTING.md](TESTING.md) — how to reproduce the claims.

The licence and attribution terms in [COMMERCIAL-USE.md](COMMERCIAL-USE.md)
apply to everything described here.
