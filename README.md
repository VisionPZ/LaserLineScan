<!--
  SPDX-License-Identifier: GPL-3.0-or-later
-->

# Laser Line Scan

[![Licence: GPL-3.0-or-later](https://img.shields.io/badge/licence-GPL--3.0--or--later-blue.svg)](LICENSE)
[![CI](https://github.com/VisionPZ/LaserLineScan/actions/workflows/ci.yml/badge.svg)](https://github.com/VisionPZ/LaserLineScan/actions/workflows/ci.yml)
[![Browser-only: no server, nothing uploaded](https://img.shields.io/badge/browser--only-no_server%2C_nothing_uploaded-success.svg)](#quick-start)

**Laser Line Scan** is a browser-only structured-light laser scanner. It walks a full
laser-perception pipeline - 00 optics, 01 rig, 02 calibration, 03 object scan,
04 dense 3D result - in ES modules, Web Workers and a WebAssembly kernel
compiled from AssemblyScript. Everything runs **on your machine**: no server, no
upload, no telemetry. The frames, the calibration and the point cloud never leave
the browser. The project exists so that the whole pipeline can be studied,
modified and used without a proprietary component hidden behind an API.

## Quick start

**Hosted demo, no install:** [English](https://www.nidvue.com/laser-line-scan/) · [中文](https://www.nidvue.com/zh/laser-line-scan/). The hosted lab and this package share the processing pipeline; the package includes smaller demonstration capture sequences, so results need not match a hosted run. The technical article is available in [English](https://www.nidvue.com/articles/laser-line-scan-defect-inspection/) and [中文](https://www.nidvue.com/zh/articles/laser-line-scan-defect-inspection/).

To run it yourself, no build step and no npm dependencies are needed. You need **Node.js 20 or newer** and a modern browser. Install **Git LFS** before cloning the GitHub repository: it stores the capture images, reference depth, and compiled kernel.

```sh
git lfs install
git clone https://github.com/VisionPZ/LaserLineScan.git laser-line-scan
cd laser-line-scan
git lfs pull
node serve.mjs
# open http://localhost:8080
```

`serve.mjs` is a zero-dependency static server that sends the right MIME types
(`.wasm` in particular). Any static file server works; set `PORT` or pass
`--port` to change the port.

Then walk the five steps below.

## The five steps

Each step is one stage of the pipeline, and each can be changed and re-measured on its own. The
screenshots follow the theme of the page you are reading.

These five steps are the shape of the pipeline. The detailed technical explanation, every stage's
algorithm together with its formulas, is published as an article:
[Laser Line Scanning: From Calibration to Sub-mm Geometry](https://www.nidvue.com/articles/laser-line-scan-defect-inspection/).

### 00 Optics

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/step-00-optics.webp">
  <img alt="Step 00: laser spectrum, lens filter and ambient light controls" src="docs/screenshots/step-00-optics-light.webp">
</picture>

The optical design fixes the laser's spectral line, the filter's transmission and the ambient
spectrum. The same design determines the direction along which the stripe is scored, so a
change of wavelength changes the detector as well as the image. Select **“Set up the rig →”**.


**Algorithm.** The sensor-weighted laser and ambient yields are integrated over 1 nm samples from 380 to 1000 nm, $L=\sum_\lambda \mathrm{laser}\,\mathrm{filter}\,\mathrm{sensor}$ and $A_{\mathrm{amb}}=\sum_\lambda \mathrm{ambient}\,\mathrm{filter}\,\mathrm{sensor}$, and the same design fixes the direction $\mathbf{w}=\mathbf{c}/\lVert\mathbf{c}\rVert_2$ along which the stripe is later scored. The model, including the incidence-angle filter shift, is in [docs/OPTICS-MODEL.md](docs/OPTICS-MODEL.md).

### 01 Rig

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/step-01-rig.webp">
  <img alt="Step 01: the camera and laser sheet meeting at the calibration board, with baseline and working-distance controls" src="docs/screenshots/step-01-rig-light.webp">
</picture>

The rig view exposes the baseline and the working distance. Both govern how a displacement of
the stripe in the image translates into a change in reconstructed depth. Select **“Set up
calibration →”**.


**Algorithm.** The laser sheet is $AX+Y+BZ=C$. A camera ray $\mathbf{r}=[x_u,y_u,1]^{\mathsf T}$ meets it at $Z=C/D$ with $D=Ax_u+y_u+B$, and the local sensitivity $\partial Z/\partial y_u=-C/D^2$ shows why rays nearly parallel to the sheet are the error-prone ones. The geometry is derived in [docs/CALIBRATION.md](docs/CALIBRATION.md).

### 02 Calibration

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/step-02-calibration.webp">
  <img alt="Step 02: the ChArUco board, its detected corners and the fitted calibration report" src="docs/screenshots/step-02-calibration-light.webp">
</picture>

Calibration solves the camera and the laser plane against a board of known geometry, and
reports the residual, the board span and the fitted distortion. The two board sets correspond to
the two motion models: a fixed board with a moving laser, or a moving board with a fixed laser.
Select a set, then **“▶ Start calibration”**.


**Algorithm.** Board poses yield stripe intersections in 3D, and the plane is fitted by iteratively reweighted least squares on the algebraic residual $r_i=Y_i+AX_i+BZ_i-C$. The fixed-board model constrains every plane through the emitter, $C=E_y+AE_x+BE_z$. Details in [docs/CALIBRATION.md](docs/CALIBRATION.md).

### 03 Object scan

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/step-03-scan.webp">
  <img alt="Step 03: an object frame with the detected stripe, the scan controls and the viewer" src="docs/screenshots/step-03-scan-light.webp">
</picture>

Each object frame is decoded, the stripe is extracted inside its geometric band, the rows the
search excluded are checked and missing-column recovery is attempted. Points accumulate in the
worker; the result viewer receives the completed cloud after scanning finishes. Select **“◇ Scan”**.


**Algorithm.** The score projects each pixel onto the designed color, $S=\max(0,\mathbf{w}^{\mathsf T}\mathbf{I}-\ell)$, where $\ell$ approximates the median projected background from sampled, binned pixels. Geometry restricts the search to a row band $v(z,u)=c_y+f_y(C/z-B-Ax_u)$; excluded rows are checked against the threshold, and recovery attempts to fill missing columns. Recovery still uses blue excess, so it does not provide the main detector's support for green and red designs. See [docs/SCAN-PIPELINE.md](docs/SCAN-PIPELINE.md).

### 04 Dense 3D result

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/step-04-result.webp">
  <img alt="Step 04: the reconstructed point cloud, colored by depth, with the reported error and coverage" src="docs/screenshots/step-04-result-light.webp">
</picture>

The completed scan: the cloud is colored by depth, alongside the reconstruction error, the
scan coverage and the search-verification status the run reports. The view can be orbited and the
cloud exported as PLY.



**Algorithm.** Each frame's reconstructed points are scored against the reference depth named by its manifest, $e_f=s_{\mathrm{mm}}\lVert(\hat Z_f-Z_f^{\mathrm{ref}})\mathbf{r}\rVert_2$. The packaged moving-rig captures have per-frame depth maps; the packaged fixed-rig captures use one shared map per scene. Coverage is $\min(1,N_{\mathrm{scored}}/N_{\mathrm{expected}})$, an aggregate column ratio rather than surface-area completeness. The evaluation model is described in [docs/SCAN-PIPELINE.md](docs/SCAN-PIPELINE.md) and [docs/DATA-FORMATS.md](docs/DATA-FORMATS.md).

## Development environment (Nix)

The toolchain is pinned by a Nix flake against **nixpkgs 25.11** - node 22, python
with playwright, a Chromium for the probe and git-lfs - so nothing depends on what
happens to be installed.

```sh
nix develop                  # the environment; it exports NIDVUE_CHROMIUM
npm test                     # unit and integration tests
node serve.mjs               # then open http://localhost:8080
python3 tests/smoke.py       # the browser walkthrough (calibration + scan)
nix build                    # the publishable site as a store path
nix run .#serve              # serve that build
```

`direnv allow` picks the shell up automatically through the committed `.envrc`.

## Features

- **00 Optics** - model the laser wavelength and width, the lens band-pass
  filter, the ambient light and the sensor response, with live spectrum and RGB
  plots.
- **01 Rig** - camera and laser geometry with an interactive 3D preview of the
  head, the field of view and the projected light sheet.
- **02 Calibration** - ChArUco corner detection, camera intrinsics and
  distortion, board pose, laser-plane and affine command-to-plane fitting.
- **03 Object scan** - per-frame sub-pixel stripe extraction (full-frame and
  calibration-derived ROI, several estimators, colour and monochrome paths),
  with scatter-tail recovery for saturated or faint lines.
- **04 Dense 3D result** - an interactive viewer with orbit, pan and zoom, plus
  **PLY** and **JSON** export.
- **Private by construction** - no upload, no telemetry, no server round trip.
- **Dependency-free runtime** - plain ES modules, no bundler and no framework.

## Project layout

```text
.
├── .github/           CI workflow, issue and pull-request templates
├── demo/              prebuilt demonstration captures (calibration + validation)
├── docs/              design notes and the commercial-use guide
├── runtime/           the shipped ES modules, vendored libraries and core.wasm
├── tests/             Node tests and the Playwright browser probe
├── tools/             demo-dataset and index.html generators
├── CHANGELOG.md       release history
├── CITATION.cff       citation metadata
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE            the full GPL-3.0 text
├── NOTICE             attribution term and third-party licences
├── README.md
├── SECURITY.md        how to report a vulnerability
├── index.html         prebuilt English page (generated by tools/build-index.mjs)
├── package.json       metadata plus `npm run serve` / `npm test` (no dependencies)
└── serve.mjs          zero-dependency static server
```

The `demo/` tree holds 50 calibration frames per rig. Validation ships all five
scenes the page offers - `bin`, `bottles`, `bridge`, `rail` and `plush` - for
both rigs, so no card is selectable without data behind it. Each moving-rig
scene carries 12 scan lines, each with its own truth volume because that volume
describes a single camera pose. The fixed rig carries 40 lines for `bin` and
24 for each other scene, with one shared truth volume per scene. The multi-gigabyte
HD capture sequences are **not** shipped - see
[Regenerating things](#regenerating-things).

## Documentation

The design notes live under [`docs/`](docs/README.md). The end-to-end technical explanation,
with the pipeline's formulas, is published on the website:
[Laser Line Scanning: From Calibration to Sub-mm Geometry](https://www.nidvue.com/articles/laser-line-scan-defect-inspection/).

| Document | Contents |
| --- | --- |
| [`docs/README.md`](docs/README.md) | Index of the documentation set. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules, workers and the data flow through the pipeline. |
| [`docs/OPTICS-MODEL.md`](docs/OPTICS-MODEL.md) | The spectral illumination model. |
| [`docs/CALIBRATION.md`](docs/CALIBRATION.md) | ChArUco detection, camera model and laser-plane fitting. |
| [`docs/SCAN-PIPELINE.md`](docs/SCAN-PIPELINE.md) | Stripe extraction, search ROI, scatter recovery and reconstruction. |
| [`docs/DATA-FORMATS.md`](docs/DATA-FORMATS.md) | Manifests, the demo dataset and the PLY/JSON exports. |
| [`docs/RENDERING.md`](docs/RENDERING.md) | The viewer and the WebGPU/WebGL2/CPU rendering paths. |
| [`docs/TESTING.md`](docs/TESTING.md) | Test layers and how to run them. |
| [`docs/COMMERCIAL-USE.md`](docs/COMMERCIAL-USE.md) | The licence explained for businesses. |

## Testing

The Node suite is dependency-free and needs no browser:

```sh
# Unit tests: kernel, spectral model, calibration maths, worker protocol.
node --test tests/unit/

# Whole Node suite (unit + static integration): the `npm test` script.
npm test            # all packaged Node tests
```

The end-to-end browser probe starts `serve.mjs` itself, drives the wizard and
asserts a real point cloud is produced:

```sh
pip install playwright
playwright install --with-deps chromium
NIDVUE_CHROMIUM="$(python -c 'from playwright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()')" \
  python tests/smoke.py
```

`tests/smoke.py` needs Python, Playwright and a Chromium binary; it reads the
binary path from `NIDVUE_CHROMIUM` and optionally the port from
`LASER_SCAN_PORT`.

## Browser support

Required:

- **WebAssembly** - the extraction/calibration kernel.
- **Web Workers** - the kernel and ChArUco work run off the main thread.
- **OffscreenCanvas** - image processing off the main thread.
- **DecompressionStream** - reading the compressed dataset volumes.

**WebGPU** is optional. When it is unavailable the spectral and viewer previews
fall back to **WebGL2** and then to a **CPU** path, so the pipeline still runs.

## Regenerating things

The repository ships prebuilt artefacts so a fresh clone runs with no toolchain.

- **Kernel** - `runtime/core.wasm` is compiled from the AssemblyScript source
  `kernel/oss.ts` (shipped here) with
  `asc --runtime stub --exportRuntime`:

  ```sh
  npm install        # once - installs assemblyscript
  npm run build:kernel
  ```

- **Demo dataset** - `node tools/make-demo-dataset.mjs` rebuilds `demo/` from
  the upstream rendered `public/laser/hd/` capture tree. That HD tree (and its
  `*.f32.gz` volumes) is **not** shipped here: it is a generated build input
  ignored by Git, so this script only works in a checkout that has it.

- **index.html** - `node tools/build-index.mjs` regenerates the prebuilt
  English page from the upstream content and page template.

## Licence and attribution

laser-line-scan is released under the **GNU General Public License, version 3 or
later (GPL-3.0-or-later)**, with an **additional attribution term** under GPLv3
**section 7(b)**. The full licence text is in [`LICENSE`](LICENSE); the
attribution requirement and the bundled third-party licences are in
[`NOTICE`](NOTICE).

**Commercial use is allowed.** You may build a commercial product with
laser-line-scan. The condition is the one the GPL already imposes: if you distribute
a product that contains or is derived from laser-line-scan, you must release that
product's **complete corresponding source** under **GPL-3.0-or-later** and keep
the attribution visible in its UI, documentation and sources. You cannot ship
laser-line-scan inside a product that keeps its source private.

Any distribution must preserve this notice in the user interface, the
documentation and the source headers:

See [`docs/COMMERCIAL-USE.md`](docs/COMMERCIAL-USE.md) for the plain-language
explanation and contact
[contact@nidvue.com](mailto:contact@nidvue.com) with licensing questions.

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md) for
development setup, coding conventions, the test commands and the pull-request
checklist. Behaviour changes are expected to come with tests, and every commit
must be signed off (DCO). By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).
