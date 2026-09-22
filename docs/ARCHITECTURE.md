<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Architecture

**laser-line-scan** is a browser-only structured-light laser scanner: five wizard
steps, plain ES modules, Web Workers and one WebAssembly kernel. Nothing is
uploaded and no server-side computation exists — the frames, the calibration
and the point cloud stay in the page. The package root
[`README.md`](../README.md) covers installation; this page describes the
system itself. The physical model is described in
[OPTICS-MODEL.md](OPTICS-MODEL.md), the measurement steps in
[CALIBRATION.md](CALIBRATION.md) and [SCAN-PIPELINE.md](SCAN-PIPELINE.md),
the on-disk contracts in [DATA-FORMATS.md](DATA-FORMATS.md), and the drawing
code in [RENDERING.md](RENDERING.md).

## The five-step wizard

The lab is a linear wizard with one active panel at a time. `app.js`
(`goStep`, `state`) drives it: `goStep(n)` shows the `[data-panel]` whose
index matches, sets `aria-current="step"` on the matching
`.ll-stepper [data-step]` button and moves focus. Later steps are disabled
until their prerequisite exists — step 03 needs a completed calibration,
step 04 needs a completed scan (`state()` in `app.js`). The upstream design
rationale is recorded in the parent `docs/LASER-UI-AUDIT.md`.

| Step | Panel | Purpose | Primary modules |
| --- | --- | --- | --- |
| 00 optics | Design the illumination | Laser diode, lens bandpass, camera sensitivity, ambient light; live spectrum plot and derived metrics | `spectral.js`, `spectral-plot.js`, `spectral-gl.js` |
| 01 rig | Inspect the camera/laser head | Rigid head, camera field-of-view frustum, laser sheet, baseline/standoff sliders and dimension rulers | `rig-scene.js`, `viewer.js` |
| 02 calibration | Calibrate the rig | ChArUco corner detection, camera solve, board pose, laser-plane fit, encoder map, search ROI and reports | `charuco-worker.js`, `board-pose.js`, `encoder-model.js`, `stripe-roi.js`, `calibration-report.js` |
| 03 scan | Scan the object | Per-frame shading, banded stripe extraction, row gate, verification, scatter recovery and triangulation | `worker.js`, `rows-pca.js`, `scatter.js`, `stripe-roi.js`, kernel |
| 04 result | Inspect the point cloud | Orbit/pan/zoom, colour modes, mesh, bounding box, PLY/JSON export | `viewer.js`, `app.js` |

`app.js` owns the wizard state, dataset selection, parameter invalidation,
progress and cancellation, and the exports. Changing calibration inputs clears
the fit and any later result (`clearCalibration`); selecting another validation
scene keeps a completed calibration (`select`).

## Module map

All modules are ES modules under [`../runtime/`](../runtime/) and are loaded by
[`../index.html`](../index.html) directly; there is no framework and no
bundler.

| Area | Modules | Responsibility |
| --- | --- | --- |
| Optics model | `spectral.js` | Wavelength-grid model: laser, filter, sensor QE and ambient, plus the capture transform (`spectralModel`, `transformSpec`, `applySpectral`). |
| Optics renders | `spectral-plot.js`, `spectral-gl.js` | The interactive spectrum plot; the GPU/CPU frame re-render (`applySpectralFrame`) and the WebGL2 spectrum canvas. |
| Calibration | `board-pose.js`, `charuco-worker.js`, `encoder-model.js` | ChArUco detection (`detectView`), camera calibration (`calibrateViews`), board pose (`poseView`), plane/ROI orchestration, the two-axis encoder map (`fitEncoderModel`, `planeAt`). |
| Scan | `worker.js` | The job runner: prefetch, decode, shade, extract, verify, recover, triangulate, score. |
| Scan helpers | `rows-pca.js`, `stripe-roi.js`, `scatter.js` | The learned row gate, the calibration-derived search band, and scatter/saturation recovery. |
| Rendering | `viewer.js`, `rig-scene.js` | The measured point-cloud viewer and the procedural rig scene. |
| Kernel | `../runtime/core.wasm` | The AssemblyScript stripe extractor, plane fits and per-pixel capture transform (upstream source `assembly/laser/oss.ts`). |
| Support | `image-preview.js`, `locale.js`, `charuco-board.js`, `calibration-report.js` | Frame-view navigation, number formatting, the board texture bits, and the Markdown/PowerPoint reports. |

## Worker boundary and message flow

`app.js` (`run`) starts one module worker per job:
`new Worker(new URL('worker.js', import.meta.url), {type:'module'})`. A job is
either a **calibration** (`action:'calibrate'`) or an **object scan**
(`action:'validate'`); the worker refuses any other action and any validation
that does not match an existing calibration (`incompatible`). The app and the
worker exchange a small, typed message protocol:

| Direction | Message | Payload |
| --- | --- | --- |
| app → worker | job | `{action, dataset, config, calibration?, mono}` |
| worker → app | `buffering` | `{type, done, total}` while every frame of the split is fetched into memory |
| worker → app | `progress` | `{type, stage, done, total, file, blob, processingMs, extra}` per displayed frame (`extra` carries detection corners or the ROI band) |
| worker → app | `calibrated` | `{type, dataset, rigId, version, config, fit, camera, boardMetrics, planeFits, planeSummary, encoderModel, stripeRoi, calibrationFrames}` |
| worker → app | `result` | `{type, dataset, validationDataset, config, fit, planeFits, encoderModel, planeSummary, boardMetrics, scanTopology, points, colors, errors, observations, metrics, calibrationVersion, manifest}` |
| worker → app | `error` | `{type, message}` |
| app → worker | `frame-shown` | `{type, done}` backpressure acknowledgement |

Two mechanisms coordinate frame processing:

- **Prefetching.** `startFrames` queues frame downloads and reports `buffering`
  progress as they finish. Processing can start before the whole split arrives;
  each frame waits for its download and decode. Browser connection scheduling
  controls the network concurrency.
- **Backpressure.** `read()` in `worker.js` posts a `progress` message with the
  decoded blob and then waits for the app's `frame-shown` acknowledgement
  before the next frame. Processing therefore cannot skip a frame the user
  never saw. A thin `self.onmessage` wrapper consumes `frame-shown` messages
  so they are never mistaken for a new job.

`app.js` decodes and displays each delivered blob (`showFrame`), draws the
search-band outline from the same geometry the worker used, then acknowledges.
For calibration the worker emits detected corners (`extra.view`) for the live
overlay; the frame view draws the ROI band for later frames.
The worker sends the completed cloud in one `result` message; the viewer's
reveal animation begins after that message, not during reconstruction.

## WebAssembly kernel boundary

`worker.js` instantiates the kernel once per worker from
`../runtime/core.wasm`:

```js
wasm = (await WebAssembly.instantiate(binary, {env:{abort(){throw new Error('Numerical kernel aborted');}}})).instance.exports;
```

The kernel is compiled from the packaged `kernel/oss.ts` (mirrored from the
upstream `assembly/laser/oss.ts`) with the
AssemblyScript compiler and is shipped pre-built (`--runtime stub
--exportRuntime`, per the package `README.md`). It holds fixed-capacity static
buffers: `1920 × 1080` pixels, `1920` stripe columns, and `240000` reference
samples for the plane fits (upstream `docs/LASER-CALIBRATION.md`). Images
larger than `1920 × 1080` are rejected by `configureImage`.

Data crosses the boundary through pointers into `wasm.memory.buffer`, not
through copies of objects:

| Export | Used for |
| --- | --- |
| `configureImage(width, height, stride)` | Sets the image size and bytes-per-pixel (4 = colour RGBA, 1 = monochrome; a `0` stride selects 4). |
| `inputPtr()`, `stripePtr()` | The uploaded pixel buffer and the returned `[u, v, score]` triples. |
| `bandTopPtr()`, `bandBottomPtr()` | The per-column search band (`extractBanded`). |
| `excludedMaxPtr()`, `excludedRowPtr()`, `thresholdValue()` | Per-column strongest integer-binned excluded score/row and the threshold sampled across all rows of the horizontal ROI. |
| `shadingCurvePtr()` | The 91-sample angle-gain curve for `configureShading`. |
| `extract` / `extractBanded` | Full-sensor and banded stripe extraction over four estimators. |
| `verifyExcluded(mode, left, right)` | Counts columns whose out-of-band score still exceeds the threshold. |
| `addReference` / `fit` | Robust IRLS fit of the translating moving-board laser plane. |
| `addPlanePoint` / `fitPlane` | Robust IRLS fit of the ChArUco laser plane (optionally constrained to a known emitter). |
| `depth` / `generalDepth` | Ray/plane intersection helpers. |
| `configureShading`, `shade`, `clearShading` | The per-pixel capture transform, with a field computed once per job. |
| `setScorePlane(w0, w1, w2, floor)` | Designed-colour projection direction and approximate background level for score mode 2. |
| `reset()` | Clears the accumulated calibration samples. |

The worker reads and writes these buffers with typed-array views over
`wasm.memory.buffer`. The full extraction mechanics are in
[SCAN-PIPELINE.md](SCAN-PIPELINE.md); the transform is in
[OPTICS-MODEL.md](OPTICS-MODEL.md).

## Where data lives

| Path | Contents |
| --- | --- |
| [`../runtime/`](../runtime/) | The shipped ES modules, the compiled `core.wasm`, the trained row-gate weights (`rows-pca.f32`, `rows-pca.json`), styles and vendored OpenCV.js/pptxgen.js. |
| [`../demo/`](../demo/) | The small demo capture set: `demo/calibration/<rig>/` and `demo/validation/<rig>/<scene>/`, each with `manifest.json`, frames and (for validation) truth volumes. |
| `hd/`, `hd-mono/` | The generated full-resolution capture sequences. They are **build inputs**, ignored by Git and absent from a clone; see [DATA-FORMATS.md](DATA-FORMATS.md). |
| [`../index.html`](../index.html) | The prebuilt English page (generated by `tools/build-index.mjs` from the upstream template). |
| [`../serve.mjs`](../serve.mjs) | The zero-dependency static server with correct MIME types (notably `.wasm`). |
| `../tools/` | `build-index.mjs` (page regeneration) and `make-demo-dataset.mjs` (demo regeneration). |
| `../tests/` | The Node and Playwright suites; see [TESTING.md](TESTING.md). |

## Browser requirements

The page checks for `window.Worker`, `window.WebAssembly`,
`window.OffscreenCanvas` and `window.DecompressionStream` before starting
(`app.js`); any missing API raises `browserError`. The scan also needs an
`OffscreenCanvas` 2D context in the worker. GPU capability is optional: the
3D viewer uses one WebGL context (`viewer.js`, `ScanViewer`) and the frame
re-render prefers WebGPU, then WebGL2, then the CPU transform — see
[RENDERING.md](RENDERING.md).
