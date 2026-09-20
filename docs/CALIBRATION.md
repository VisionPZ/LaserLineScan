<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Calibration (step 02)

Calibration measures the camera, the board poses and the laser sheet, then
derives the search ROI the scan uses. It runs as a worker job orchestrated by
[`../runtime/charuco-worker.js`](../runtime/charuco-worker.js) on top of the
ChArUco and camera-solve primitives in
[`../runtime/board-pose.js`](../runtime/board-pose.js), the encoder map in
[`../runtime/encoder-model.js`](../runtime/encoder-model.js), the ROI geometry
in [`../runtime/stripe-roi.js`](../runtime/stripe-roi.js), and the plane fits in
the WebAssembly kernel. The report exporters are in
[`../runtime/calibration-report.js`](../runtime/calibration-report.js). The
dataset contracts this step consumes are in
[DATA-FORMATS.md](DATA-FORMATS.md); the scan that consumes its output is in
[SCAN-PIPELINE.md](SCAN-PIPELINE.md).

## Two acquisition methods

The package ships two independent calibration methods (`manifest.acquisition`):

- **`moving-board` · fixed laser** — the board translates and rotates through
  the stationary laser plane. One camera-fixed plane is fitted from all poses.
  During validation the rigid camera and laser head translate together on a
  stage and each frame records its displacement.
- **`fixed-board` · moving laser** — the board is clamped; the laser covers it
  at random orientations. One stripe on one fixed plane cannot uniquely
  identify the plane, so the acquisition supplies a **known emitter** and each
  recovered plane is constrained to pass through it; the 50 fitted planes then
  train a command-to-normal map.

Both use a true 8 × 6 ChArUco board with 40 mm squares, 29 mm markers and
OpenCV's `DICT_5X5_100` dictionary (`manifest.board`, and
`public/laser/DATASET-CARD.md`). The parent `docs/LASER-CALIBRATION.md`
describes the same two methods.

## ChArUco detection and camera calibration

`board-pose.js` loads the vendored OpenCV.js 4.13.0 (`boardRuntime`) and builds
one detector per manifest (`buildDetector`): an `aruco_CharucoBoard` with the
manifest's square size in model units, an `aruco_DetectorParameters` whose
`cornerRefinementMethod` is `CORNER_REFINE_SUBPIX` when the `subpixel` option
is chosen (window 5, 40 iterations, minimum accuracy 0.001) and
`CORNER_REFINE_NONE` otherwise, and an `aruco_RefineParameters(10, 3, true)`.

`detectView(cv, manifest, frame, pixels, mode)` turns one decoded frame into
detected corner ids plus image (px) and object (board-unit) points. It builds
the grey image from the **red** channel, `gray[i] = pixels[i * 4]`; the parent
doc records why: a 450/40 bandpass at OD 5 leaves about 10% of the ambient and
the detector reads red, so the board's red percentile would collapse and no
threshold could separate the squares. Corner coordinates are converted to the
package's boundary-origin convention by adding `0.5` to the OpenCV values.
Fewer than 20 detected corners raises `cornerFailed`.

`calibrateViews(cv, manifest, views, model)` solves the camera:

- If the board-pose diversity is too small (fewer than two planes, or all
  normals within 0.05 rad), the camera is **specified** rather than estimated —
  this is the fixed-board rig with one pose. It reuses the manifest's known
  lens coefficients, matching the selected distortion model.
- Otherwise it calls `cv.calibrateCameraExtended` seeded with
  `CALIB_USE_INTRINSIC_GUESS` and the manifest intrinsics. The parent doc
  records the measured effect: seeding converges “~6 s → ~0.1 s” instead of
  OpenCV's default `fx = fy = max(width, height)` start.
- Distortion models are `none`, `brown` (`k1,k2,p1,p2,k3`, 5 terms) and
  `rational` (`k1…k6`, 8 terms, needs `CALIB_RATIONAL_MODEL`). A solve whose
  RMS is not finite, exceeds 5, or whose `fx` is not positive raises
  `cameraFailed`.

`poseView(cv, view, camera)` runs `solvePnP` (`SOLVEPNP_ITERATIVE`) for one
view, converts the rotation vector with `Rodrigues`, and returns the board
plane `n · P = d` from the rotation matrix's third column and the translation,
plus the per-frame `cornerCount` and `reprojectionRmse`.

The worker runs the step in two passes (`calibrateCharuco`): pass 1 detects
corners on every frame and calibrates the camera from those views; pass 2 takes
each pose from the calibrated camera, undistorts the stripe and accumulates 3D
points for the plane fit. Detected corners are streamed to the UI live as the
calibration `progress` `extra.view` payload.

## Laser-plane fit

The kernel implements both fits as robust IRLS (6 iterations, inlier band
`cutoff × 3`, cutoff = `outlierMm / unitMm`, default 0.5 mm):

- **Moving board:** `fit(cutoff, fixedTilt, tilt)` fits `Y + a Z = b + c t` —
  one camera-fixed plane whose offset may drift with the stage parameter `t`.
  Coefficients are `[a, b, c, rms, inliers, samples]`; the result must have
  more than 100 inliers and finite coefficients.
- **Fixed board:** `fitPlane(cutoff, knownEmitter, ex, ey, ez)` fits the
  general plane `Y + nx X + nz Z = d`, constrained to pass through the known
  emitter when `knownEmitter` is set:
  `d = ey + nx·ex + nz·ez`. The result must have at least 60 inliers.

Each fixed-board frame gets its own plane (`planes[frame.command]`), gathered
from the frame's stripe points; the moving-board calibration produces one plane
reused by every frame. `charuco-worker.js` aggregates the fixed-board fits
into a summary (`aggregate`) and returns them as `planeFits`.

The known fixed-board emitter is `manifest.emitterCamera`, shipped as
`[0, −2.0177, 1.4413]` in model units — `(0, −202, 144)` mm, exactly the
figure in `public/laser/DATASET-CARD.md`. `manifest.emitterBaselineMm` is the
248 mm head baseline (also in the dataset card and `rig-scene.js`).

## Emitter / encoder model

`encoder-model.js` fits the learned two-axis command-to-normal map for the
fixed-board rig:

- `fitEncoderModel(samples, emitter)` uses at least 10 samples and five IRLS
  passes to fit `[nx, nz] = b0 + b1·qx + b2·qy` per normal component (a 3×3
  solve in `solve3`). Encoder readings are acquisition metadata; no rendered
  coefficients or validation depths enter the fit.
- The model stores the emitter, the per-axis bounds of the observed command
  positions, and a `normalRmse` from the residual between the fitted and
  recovered normals — the *encoder normal RMSE* metric.
- `planeAt(model, position)` evaluates the map and returns the plane offset;
  commands outside the calibrated per-axis bounds raise `commandRange`. This is
  why the fixed-board validation frames the demo ships are clipped to the
  calibrated bounds (`tools/make-demo-dataset.mjs`).

## Search-ROI derivation

Calibration estimates once the image rows a stripe can occupy, and validation
scores only those rows. The geometry is in `stripe-roi.js` under the plane
convention `A X + Y + B Z = C`. A pixel `(u, v)` sees the normalized ray
`(xu, yu) = undistort(u, v)`; the sheet meets depth `z` at
`yu(z) = C/z − B − A·xu`, which projects to row `v(z) = cy + fy·yu(z)`
(module header). The mapping is monotonic in depth, so a column's stripe lies
between the rows of the shallowest and deepest expected surfaces.

- **Working depth interval.** `determineRoiDepth(depths, margin = 0.2, floor = 0.15)`
  runs inside calibration. It keeps finite positive stripe depths, needs at
  least 20, takes the **2nd/98th percentiles**, and expands by
  `max(floor, margin × width)`, clamped to the reconstruction range
  `DEPTH_MIN = 1 … DEPTH_MAX = 8` model units. The parent doc explains that the
  fallback is only as close to the object as the reference target happened to
  be.
- **Declared standoff.** Each validation manifest may declare
  `objectDepth` (rounded outward to 0.1 model units = 10 mm). `declaredDepth`
  is the one validity test every reader shares, and `resolveDepthPrior` prefers
  the declared interval over the calibration estimate.
- **Per-column band.** `stripeBand(plane, camera, width, height, depth, margin = 8)`
  projects the near/far depths through the calibrated lens (including
  `undistortPoint`/`distortPoint` when a lens model is present) into a
  per-column `[top, bottom)` interval with a pixel guard.
  `stripeBandUncertainty` instead widens each edge by `k` standard deviations
  from `bandUncertaintyOptions` (`k = 3`, pixel sigma 0.5, the board
  reprojection RMSE as the camera term, the plane fit's
  `rms / √samples` from `planeCoefficientSigma`, and a depth term; floor
  `bandMinMarginPx = 4`, cap `bandMaxMarginPx = 160`).
- **Object-column bound.** `resolveObjectColumns` projects the manifest's
  `objectBox` AABB through the lens and returns a `[left, right)` column range;
  `clipBandColumns` clears the band outside it. Because it is the conservative
  AABB, the bound is lossless. The parent doc measures the narrowing from 78%
  (bin) down to 41% (rail) of the image width.
- **One builder for worker and view.** `searchBand(calibration, manifest, frame, config, plane)`
  reads the depth prior, the band mode (`bandMode: 'fixed'` or the default
  uncertainty envelope), the margins and the object-column bound in one place.
  The worker and the frame-view outline both call it, so the green outline
  cannot disagree with the scan. `bandRows`/`bandCoverage` are the single row
  count behind the reported `scanFraction` and coverage. `framePlane` returns
  `null` when no plane exists for a frame, so a partially exported calibration
  fails the scan instead of crashing.

Measured on the published validation sample (parent `docs/LASER-CALIBRATION.md`,
`tools/laser/verify-row-gate.py`): the calibrated band searches **30.2%** of
the frame, the object box narrows it to **17.9%**, and the learned row gate
([SCAN-PIPELINE.md](SCAN-PIPELINE.md)) to **8.8%**; the uncertainty band
searches **8.7%**. Declared standoffs leave **20–38%** of the sensor to search
(mean **29%**), about 3.4× fewer rows; the default Hessian ridge estimator is
about **9×** faster per frame because its passes are banded too.

## Calibration metrics and targets

`displayCalibration` in `app.js` presents the fit and grades it against the
documented targets (`gradeMetric`):

| Metric | Value | Green | Amber | Source |
| --- | --- | --- | --- | --- |
| Reference fit residual | `fit[3] × unitMm` (mm) | ≤ 0.2 | ≤ 0.5 | `app.js` |
| Board reprojection RMSE | `boardMetrics.reprojectionRmse` (px) | ≤ 0.5 | ≤ 1.5 | `app.js` |
| Minimum laser span | `boardMetrics.minSpan` | ≥ 0.80 | ≥ 0.60 | `app.js` |
| Minimum corners | `boardMetrics.minCorners` | ≥ 30 | ≥ 20 | `app.js` |

`public/laser/DATASET-CARD.md` states the acquisition guarantees behind those
columns: the minimum stripe span over all reference images is **85.7%** of the
projected board width for the moving board and **73.4%** for the fixed board,
and all **35** internal ChArUco corners are detected in every reference image
of both methods. Those figures describe the generated acquisition, not a
guarantee of physical accuracy.

The calibration result object returned to the page carries `fit`
(`[a, b, c, rms, inliers, samples]`), `camera` (intrinsics, distortion model
and coefficients), `boardMetrics`, `planeFits`, `encoderModel`, `stripeRoi`,
`config`, `calibrationFrames`, `dataset`, `rigId` and `version`.

## Reports

The completed snapshot feeds two matching exports plus a raw JSON dump:

- `calibrationMarkdown(data, manifest, text, locale)` builds a Markdown report
  with sections 01 metrics, 02 acquisition settings, 03 plane parameters and
  04 next steps, including the `reportInliers` ratio and, for the fixed-board
  rig, the encoder model as JSON.
- `calibrationPowerpoint(...)` builds an **editable** PowerPoint presentation
  in Nidvue's design language with native text, shapes and tables (logo,
  metrics cards, settings table, plane/encoder tables and the honesty notice),
  using the vendored `pptxgen.js`.
- The `calibration-report` button in `app.js` saves the full calibration object
  as `<dataset>-calibration.json`.

The exact Markdown/PPTX field names and structure live in
`calibration-report.js` (`rows`, `calibrationMarkdown`,
`calibrationPowerpoint`); the JSON field values are described in
[DATA-FORMATS.md](DATA-FORMATS.md).

## Licence and coverage

The GPL-3.0-or-later terms and the additional attribution term are explained in
[COMMERCIAL-USE.md](COMMERCIAL-USE.md). The numerical and browser tests that
back these claims are described in [TESTING.md](TESTING.md).
