<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Testing

The package has three test categories: **unit** tests under `tests/unit/`
(pure Node, no browser), **integration** tests under `tests/` (static
integrity, the packaged server and dataset/manifest consistency), and one
**end-to-end** Playwright run, `tests/smoke.py`. This page describes what each
category covers and the exact commands to run it. It deliberately names only
the directories and the runner, because the individual test files are being
written in parallel by another lane; the commands below discover whatever is
present.

The claims these suites back are in [CALIBRATION.md](CALIBRATION.md),
[SCAN-PIPELINE.md](SCAN-PIPELINE.md) and
[OPTICS-MODEL.md](OPTICS-MODEL.md). Requirements are Node.js 20 or newer
(`package.json` `engines`) and, for the smoke run, a local Playwright install
with Chromium.

## Unit tests — `tests/unit/`, `node --test`, no browser

The unit suites run under Node's built-in test runner and never open a browser
or a server. They cover the numerical and behavioural building blocks:

- **Kernel extraction.** Numerical stripe recovery, underdetermined/no-signal
  cases, Full HD pixel bounds, reference-sample capacity, and the four
  estimators. (`../runtime/core.wasm`)
- **Kernel vs. JavaScript parity.** The kernel capture transform is pinned to
  `applySpectral()` across several designs (the “six designs” parity noted in
  the parent `docs/LASER-CALIBRATION.md`).
- **Spectral model.** Preset tables, the laser/filter/sensor/ambient integrals
  and the derived transmitted/contrast terms. (`../runtime/spectral.js`)
- **Calibration and ROI maths.** Encoder-map recovery and range checking, the
  lens-distortion coefficient order, the working depth interval, the per-column
  band, the forward/inverse lens map, banded-versus-full kernel equality, and
  the learned row gate. (`../runtime/encoder-model.js`,
  `../runtime/stripe-roi.js`, `../runtime/rows-pca.js`,
  `../runtime/board-pose.js`)
- **Recovery.** Scatter-tail and saturated-shoulder recovery, including the
  monochrome profile path. (`../runtime/scatter.js`)
- **Presentation helpers.** Locale number formatting and the rig-scene
  geometry. (`../runtime/locale.js`, `../runtime/rig-scene.js`)

```sh
# all unit suites
node --test tests/unit/

# a single file by name
node --test tests/unit/<name>.test.mjs
```

## Integration tests — `tests/`

The integration category runs under the same Node runner and checks the
package's static contracts and its server, not the numerics. It includes the
top-level `tests/` suites and the `tests/integration/` subdirectory:

- **Manifest/dataset integrity.** Every demo manifest must promise only files
  that exist, `lineCount` must match the frame array, and no manifest may
  advertise a dataset ZIP that the package does not ship.
- **Static page integrity.** `../index.html` must reference only shipped
  assets, must resolve frame images to the packaged demo tree, and must carry
  the demo frame counts. The runtime must ship `core.wasm`, `app.js`,
  `worker.js`, `lab.css` and the vendor bundle.
- **Packaged server.** `../serve.mjs` is booted as a child process and checked
  over raw HTTP: correct MIME types (notably `application/wasm`), 404 for
  missing paths, and no path-traversal leaks. Every wait is bounded so CI
  cannot hang, and the suite skips cleanly when no port can be bound.
- **Dataset consistency.** The `tests/integration/` checks reconcile the demo
  manifests with their frames and truth volumes.

```sh
# the package test script: npm test (defined in ../package.json as `node --test tests/`)
npm test

# only the integration/static suites
node --test tests/

# a single top-level suite by name
node --test tests/<name>.test.mjs
```

`npm test` is defined in `../package.json` as `node --test tests/`; it is the
canonical gate before a change is considered green.

## End-to-end — `tests/smoke.py` (Playwright)

`tests/smoke.py` is the browser proof for the packaged project. It starts
`../serve.mjs` on a free port, drives the wizard from optics to rig to
calibration, runs a full calibration and then an object scan at full speed
through the real UI and worker, and asserts a real point cloud was produced.
The packaged demo’s default moving-board split is intentionally small, so the
script selects `charuco-fixed-board`, whose split carries the shared truth
volume and enough frames to exceed the **30,000-point** threshold. It also
fails on any page error or HTTP response ≥ 400 and writes a screenshot to
`/tmp/standalone-smoke.png`.

Prerequisites: Python with `playwright` installed, and a Chromium executable.

```sh
# start nothing manually — the script starts serve.mjs itself
NIDVUE_CHROMIUM=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome \
  python tests/smoke.py
```

Optional environment variables: `LASER_SCAN_PORT` selects the port (default: a
free one) and `NIDVUE_CHROMIUM` points at an existing Chromium binary. A
representative manual run of the page is just:

```sh
npm run serve          # node serve.mjs, http://localhost:8080
```

## Upstream browser suites

The parent Nidvue repository additionally runs its own Playwright suites
against the integrated site (`tests/laser/browser.py`, `interactions.py`,
`bottles.py` and `glare.py`), which cover full calibration/validation,
interaction pacing and cancellation, the water-bottle scatter recovery, and
end-to-end glare injection. Those scripts live outside this package and are
not part of `npm test`; the measured figures they produce are quoted in
[SCAN-PIPELINE.md](SCAN-PIPELINE.md).

The licence terms for redistributing the package and its tests are in
[COMMERCIAL-USE.md](COMMERCIAL-USE.md).
