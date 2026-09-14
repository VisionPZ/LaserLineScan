<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com> -->

# Scan pipeline (step 03)

The object scan turns a calibration and a set of frames into a dense point
cloud. It runs entirely inside [`../runtime/worker.js`](../runtime/worker.js),
which drives the WebAssembly kernel and the JavaScript helpers
[`../runtime/stripe-roi.js`](../runtime/stripe-roi.js) (search band),
[`../runtime/rows-pca.js`](../runtime/rows-pca.js) (row gate) and
[`../runtime/scatter.js`](../runtime/scatter.js) (recovery). The illumination
applied first is designed in [OPTICS-MODEL.md](OPTICS-MODEL.md); the
calibration it consumes is produced in [CALIBRATION.md](CALIBRATION.md); the
manifests it reads are specified in [DATA-FORMATS.md](DATA-FORMATS.md); the
result is drawn as described in [RENDERING.md](RENDERING.md).

A validation job is only accepted if it names a split whose
`calibrationId`/`rigId` match an existing calibration (`incompatible`
otherwise), and the worker merges the scan's config over the calibration's own
(`{...calibration.config, ...data.config}`).

## 1. Pre-buffer, decode and display

`bufferFrames` fetches every frame of the split into memory (eight parallel
fetches) and reports `buffering` progress, so the scan never waits on the
network. Decoding is kept off the critical path: `primeDecode` keeps three
`createImageBitmap` decodes in flight, `takeDecoded` awaits the current one and
immediately primes the next, and `OffscreenCanvas.drawImage` + `getImageData`
produce the RGBA pixels. After each frame the worker waits for the app's
`frame-shown` acknowledgement, so processing cannot skip a frame the user never
saw (`read()`).

## 2. Frame shading — reference versus filtered

Every displayed frame is re-weighted from the reference capture with the
current step-00 design, and the scan worker applies exactly the same transform
to the decoded pixels, so the point cloud and its colours match the frame on
screen. `transformSpec` defines the two modes
([OPTICS-MODEL.md](OPTICS-MODEL.md)):

- **`reference`** — the calibration capture: ambient-lit scene, no bandpass.
  The calibration job receives the `reference` spec of the frame it shows.
- **`filtered`** — the object scan: the filter's transmission, the designed
  stripe colour and the per-pixel angle gain. `config.spectral` for a
  validation job is built as `spectralConfig('validation')`, i.e. the
  `filtered` spec.

In the worker, `read()` performs the transform in the kernel when
`wasm.shade` and `config.spectral` are available: it writes the pixels to
`inputPtr()`, calls `wasm.shade()` and copies the result back. The kernel's
`configureShading` builds the per-pixel angle-gain field **once per job**
(instead of an `atan2` per pixel per frame) from the uploaded 91-sample
`shadingCurve`, and `shade()` applies
`base × ambient × tint + s × laser × gain × stripeColor` in place
(`oss.ts`; the CPU twin is `applySpectral`). A monochrome frame skips the
colour transform (`mono`), and the calibration frame is always shown as the
ambient scene the corner detector reads.

The parent doc measured the transform's cost and the win from moving it into
the kernel: **78.7 ms → 15.3 ms** per 1920×1080 frame, cutting a full frame
from **106.9 ms → 43.6 ms** and a 192-frame scan from **20.5 s → 8.4 s**. The
remaining per-frame budget is balanced: decode ≈25%, transform ≈35%, scatter
recovery ≈22% (`docs/LASER-CALIBRATION.md`, `dist/laser/_bench`).

## 3. Blue-excess row scoring and the four estimators

The kernel addresses the uploaded buffer with `configureImage(width, height,
stride)`: stride 4 for the colour path, stride 1 for a monochrome frame. Its
score function (`score` in `oss.ts`) is:

| Path | Score |
| --- | --- |
| colour, `mode 0` (default) | `max(0, B − max(R, G))` — the blue excess that cancels a neutral background |
| colour, `mode 1` | the blue channel `B` |
| monochrome (stride 1) | the pixel's own intensity |

The colour path's blue excess is the default because it isolates the line from
the ambient (`public/laser/DATASET-CARD.md`); the parent doc records that the
monochrome path does not yet pay off because a colour-to-mono conversion cannot
suppress the ambient.

The acceptance threshold is computed **over the whole sensor** before any band
is applied (`stripeThreshold`): a 256-bin histogram of the score over the
scanned columns, a `quantile` (default **0.98**) and a floor (default
`threshold = 40` in `app.js`). The band changes *where* a peak is found, never
*whether* it is accepted. A candidate must also clear a contrast test: its
score must exceed the average of the rows three above and three below by at
least `floor × 0.35`, which rejects broad highlights.

Four line-centre estimators are selectable (`estimator`); the default is the
Hessian ridge (`3`, selected in the page template):

| # | Estimator | Sub-pixel step |
| ---: | --- | --- |
| 0 | Quadratic ridge peak | Parabolic vertex with `delta = 0.5·(a − c)/curvature`, clamped to ±0.5 px |
| 1 | Local intensity centroid | Background-subtracted weighted mean over ±2 rows |
| 2 | Integer peak | No sub-pixel refinement |
| 3 | **Hessian ridge** (default) | The *Sub-pixel Laser Line Detection* pipeline: a sigma-2 separable Gaussian, the chained Sobel derivatives, the smaller Hessian eigenvalue `fpp`/eigenvector, Steger's Taylor step, ranked by the notebook's `bright_lines` response × intensity |

The Hessian ridge (`extractRidge`) is the full notebook port: it gates every
ridge candidate on the same raw-intensity and contrast test the other
estimators use, and a saturated or flat-topped column with no valid ridge pixel
falls back to the same quadratic sub-pixel peak. `public/laser/DATASET-CARD.md`
lists the same estimator set and names `tests/` as pinning it.

## 4. The learned row gate

Even after the object-column bound, roughly 30% of the frame remains to search.
A second, cheaper pass drops most of it. `tools/laser/rows-pca.py` stacks the
**laser-free lower-half rows** of the object captures into a non-laser object
matrix, removes the mean row, and keeps the loading vectors that explain 90% of
the variance. A row that reconstructs in that basis is an ordinary object row;
a large residual after removing the centre carries laser light.

The shipped model is `../runtime/rows-pca.json` + `../runtime/rows-pca.f32`,
loaded by `loadRowGate(meta, buffer)`:

| Field | Value | Source |
| --- | ---: | --- |
| `region` | `lower` | `rows-pca.json` |
| `stride` | 8 (columns subsampled) | `rows-pca.json` |
| `dim` | 240 sampled columns | `rows-pca.json` |
| `k` | 16 loadings | `rows-pca.json` |
| `variance` / `explained` | 0.9 / 0.902 | `rows-pca.json` |
| `threshold` | 570.43 | `rows-pca.json` |
| `frames` / `rows` | 192 / 103680 | `rows-pca.json` |

`rowResidual(gate, rgba, width, y)` computes the centred score row's
reconstruction residual; `gateSpan` returns the contiguous `[first, last]` span
of rows whose residual exceeds the threshold. `applyRowGate` in the worker
intersects each column's calibrated band with that span. The parent doc records
the design trade-offs: training on the laser-free lower half costs a little
span against an earlier top-half basis (which searched 7.4% but dropped 2 of
480 stripe frames), the lower half recovers those rows, and scattered light
still tails the object residual into the stripe residual, so a lower threshold
widens the span while a higher one starts missing stripe rows.

The gate is a model of **one** score — the blue colour excess — so the worker
loads it only for `config.channel === 0` and only for colour frames; any other
colour metric or a monochrome frame falls back to the calibrated band alone. It
is deliberately **not** part of `searchBand`, so the drawn outline is a
conservative superset of the rows the gate leaves.

Measured on the published sample (parent doc): the object-column bound takes
the search from a mean **30.2%** of the frame area to **17.9%**, and the gate
halves that again to **8.8%**.

## 5. The search band and out-of-band verification

For every frame the worker resolves the plane (`framePlane`) and builds the
band with `searchBand(calibration, manifest, frame, config, plane)`
([CALIBRATION.md](CALIBRATION.md)), then calls `extractBanded`. The kernel
computes the full-sensor threshold first and then, per column, the union of the
band rows; outside the band it records the strongest raw score and its row
(`verifyExcluded`, exposed through `excludedMaxPtr`/`excludedRowPtr`). Because
every estimator accepts a candidate only when its raw score exceeds the
band-independent threshold, a column whose excluded maximum is at or below the
threshold **cannot** hide an accepted stripe centre — the banded result is then
identical to a full-sensor result. The parent doc calls this a losslessness
certificate, not a sample.

`recoverBand` in the worker checks that certificate after the first extraction.
A column that still hides a candidate is expanded to its offending row by
`recoverMarginPx` (default **6**) and the frame is re-extracted, up to
`verifyMaxPasses` (default **2**). If the budget is spent with candidates still
outside, the scan is reported **unqualified** instead of silently exporting
plausible geometry. `verifyBand: false` restores the plain band;
`bandMode: 'fixed'` restores the fixed-margin band. The result metrics carry
`verified`, `verifiedFrames`, `outOfBandRate` (expanded columns / searched
columns), `fallbackFrames` and `unqualifiedFrames`; `outOfBandRate` is also the
drift signal, because a rate that climbs across scans means the camera–laser
geometry moved.

Measured on the published sample: of true stripe pixels (blue excess > 64) the
unverified fixed band excludes 18 and the unverified uncertainty band 40, while
the verified uncertainty band excludes **0**; recovery expands only 353 columns
across 480 frames (parent `docs/LASER-CALIBRATION.md`).

## 6. Scatter-tail and saturation recovery

Transparent objects add two photometric artefacts to the line centre: a broad
volume/diffuse glow around the surface return, and — under specular glare — a
saturated core whose true centre is clipped. `scatter.js` recovers the columns
the ridge kernel did not return, gated so it only fires where the evidence is
trustworthy:

- **S1 mixture fit.** `columnProfile` builds the blue-excess profile;
  `mixtureCenter` fits `c0 + c1·y + c2·y² + a·G(y; centre, sigma)` over a window
  around the peak and returns `{centre, amplitude}`.
- **Glow precondition.** `(total − peak) / peak` must reach `glowMin` (default
  2), so a crisp opaque column is never touched.
- **Amplitude gate.** The fitted surface Gaussian amplitude must exceed
  `minAmplitude × peak` (default 0.15).
- **Continuity gate.** The recovered row must lie within `recoverContinuityPx`
  (default 4) of the linear trend of the already-measured columns, and the
  nearest measured column must be within `recoverGapPx` (default 8), so a
  genuinely missing (occluded) column is left alone.
- **S2 shoulder recovery.** A column whose core is at the sensor ceiling is
  centred from the unsaturated shoulders (`shoulderCenter`, a log-parabola fit
  of samples below `saturation = 250`), used when at least two profile samples
  are saturated.

The worker runs recovery after band verification and the row gate when
`config.recoverMissing !== false` (default on), merges the recovered
`{x, y, amplitude}` points into the stripe array and accumulates
`recoveredColumns`. The viewer carries `data-recovered` for the browser check.

Measured on the water bottles (`tests/laser/bottles.py`, moving board, 192
frames, parent doc): coverage **0.734 → 0.871**, points **91,444 → 108,588**
(+18.7%), shape error 0.671 → 0.687 mm. On the whole validation sample
(`tools/laser/verify-scatter.py`): coverage **0.446 → 0.679**, RMSE
**0.699 → 0.497 mm**, excluded stripe points 40 → 6; the opaque `bin` scene is
unchanged. End-to-end glare injection (`tests/laser/glare.py`) reports recovery
off **0.801 / 2.794 mm**, recovery S2-off **0.947 / 2.667 mm**, S2-on
**0.972 / 2.588 mm** — S2 recovers 3,061 more columns and lowers shape error.

## 7. Triangulation to a dense point cloud

For each returned stripe point the worker undistorts the pixel and intersects
the camera ray with the frame's calibrated plane:

```
[xu, yu] = undistortPoint(u, v, cam, cam.model)
z        = plane[2] / (plane[0]·xu + yu + plane[1])
```

`z` must be finite and inside the reconstruction range **1 … 8** model units
(`DEPTH_MIN`/`DEPTH_MAX` in `stripe-roi.js`). The moving-board rig then removes
the frame's recorded stage translation (`frame.translation`), and the camera
coordinate is converted to millimetres by `unitMm` (100 mm per model unit). The
worker stores each point's sampled image colour and an `observation`
`{u, v, x, y, su, sv, z, t, frame}`. The point cloud is a set of triangulated
intersections only — no reference mesh and no ground-truth depth enter the
positions.

## 8. Truth, coverage and error metrics

Evaluation truth is fetched **only after every displayed point exists**
(`worker.js`; the parent doc stresses this ordering). Each validation frame
either carries a per-frame `truth` volume or the split shares one
`validationTruth`; both are 1920 × 1080 `Float32` depth arrays. `sample()`
bilinearly samples the truth with a discontinuity guard: if any of the four
neighbour cells is zero or the cell span exceeds 0.035 model units (3.5 mm),
the sample is unscored.

For each observation the worker computes the depth from the truth (at the
observation's true-pixel coordinates `su`, `sv`), maps it back to the object
frame with the stage translation, and records the Euclidean error in
millimetres. The result metrics (`worker.js`, `metrics` object) are:

| Metric | Meaning |
| --- | --- |
| `points` | accepted ray/plane intersections |
| `scored` | observations with a usable truth sample |
| `expected` | image columns whose laser plane crosses the truth surface inside the depth range, whether or not a stripe is detectable |
| `rmse` | Euclidean error to the independent truth surface, in mm (`scored` only) |
| `maxError` | largest scored error, mm |
| `coverage` | `min(1, scored / expected)` — per-column scan coverage, not whole-object completeness |
| `stripeRoi` | the working depth interval used |
| `scanFraction` | `scannedRows / (width × height)` |
| `bandMode` / `bandSigmaK` | `fixed` or `uncertainty`, and the k used |
| `verified` / `verifiedFrames` | whether the losslessness certificate held for every verified frame |
| `recoveredColumns` | scatter/S2 points added |
| `outOfBandRate` | expanded columns / searched columns |
| `fallbackFrames` / `unqualifiedFrames` | frames that needed recovery / could not certify |

The `expected` metric is deliberately honest: a column that is occluded,
under-threshold or crossed by multiple surfaces still counts as expected, so
coverage cannot hide physically missing points
(`public/laser/DATASET-CARD.md`).

`app.js` `displayValidation` presents these numbers with interpretation lines
and grades only the out-of-target ones: coverage tiers **≥98% complete**,
**≥90% good**, **≥75% usable**, otherwise large gaps; shape error against the
**≤1 mm** target; the verification result; and an out-of-band rate that is
amber at **≥1%** and critical at **≥5%**. The recovered-point count is shown
in the result row.

## 9. Exports

The reconstructed cloud and its per-point error are exported by `app.js`
`savePly` (PLY) and the calibration snapshot by the report buttons. The file
formats are documented in [DATA-FORMATS.md](DATA-FORMATS.md); the drawing code
is in [RENDERING.md](RENDERING.md).
