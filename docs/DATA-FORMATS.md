<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com> -->

# Data formats and exports

This page specifies the on-disk contracts between the dataset generator, the
page and the exports. The scanner reads a static tree and writes only
browser-side downloads; nothing is uploaded. The manifests are defined by the
upstream renderer and by
[`../tools/make-demo-dataset.mjs`](../tools/make-demo-dataset.mjs), consumed by
[`../runtime/worker.js`](../runtime/worker.js) and
[`../runtime/app.js`](../runtime/app.js), and described in
`public/laser/DATASET-CARD.md`. The numerical meaning of the metrics built from
them is in [SCAN-PIPELINE.md](SCAN-PIPELINE.md) and
[CALIBRATION.md](CALIBRATION.md).

## Directory layout

The runtime resolves every asset relative to the package root. The demo tree
is committed and complete; the full-resolution trees are generated build
inputs.

```
demo/
  calibration/<rig>/
    manifest.json
    preview.webp
    calibration-000.jpg …            # calibration frames
  validation/<rig>/<scene>/
    manifest.json
    preview.webp
    validation-000.jpg …             # validation frames
    surface-depth.f32.gz             # shared truth volume (some splits)
    validation-truth-000.f32.gz …    # per-frame truth volume (other splits)
```

- `<rig>` is `charuco-moving-board` or `charuco-fixed-board` (`manifest.rigId`).
- `<scene>` is an object scene id (`bin` in the shipped demo; the upstream
  release adds `bottles`, `bridge`, `plush` and `rail`).
- `hd/` and `hd-mono/` mirror the same two layouts at full resolution
  (`hd/calibration/<rig>/`, `hd/validation/<rig>/<scene>/`). They are ignored
  by Git (`.gitignore`) and absent from a clone; the upstream generator
  `tools/laser/render-hd.py` and `tools/laser/make-mono-dataset.py` produce
  them. The app switches between them with the `?mono=1` query flag
  (`app.js` `datasetBase`, `MONO`).

`make-demo-dataset.mjs` states and enforces the demo counts:

| Split | Frames shipped | Truth |
| --- | ---: | --- |
| `charuco-moving-board` calibration | 12 | — |
| `charuco-fixed-board` calibration | 12 | — |
| `charuco-moving-board/bin` validation | 12 | per-frame `validation-truth-NNN.f32.gz` |
| `charuco-fixed-board/bin` validation | 40 | shared `surface-depth.f32.gz` |

The fixed-board split carries more frames because the kernel returns at most one
point per image column, so 12 frames of a 1920 px image cannot reach the
≥30,000-point end-to-end assertion; the moving-board split needs a per-frame
truth volume (the camera translates) and stays at 12
(`tools/make-demo-dataset.mjs` header comment).

For comparison, the upstream Full HD release ships **2,020** native
1920 × 1080 JPEGs: two ChArUco calibration sets of **50** representative
exposures each and five objects acquired for each of the two rigs with **192**
validation images per scene (`public/laser/DATASET-CARD.md`). The parent
`docs/LASER-CALIBRATION.md` describes the same figures.

## Frame naming

- Calibration frames: `calibration-NNN.jpg` (`NNN` is a zero-padded sequence
  number; the shipped demo files are evenly spaced copies of upstream frames).
- Validation frames: `validation-NNN.jpg`.
- Per-frame truth: `validation-truth-NNN.f32.gz`.
- Shared truth: `surface-depth.f32.gz`.
- Every split carries one `preview.webp`.

All JPEGs are native 1920 × 1080 at quality 96, 4:4:4 chroma sampling
(`manifest.downloadFormat`/`downloadQuality`, and the dataset card). The demo
frames are the same JPEGs at a reduced count.

## Manifest fields that matter

A manifest is one JSON object per split. The top-level fields the runtime reads:

| Field | Meaning |
| --- | --- |
| `id`, `split`, `version` | Split identity and dataset version (e.g. `2.1.0`). |
| `width`, `height` | Native frame size; the worker rejects a mismatch with the calibration camera. |
| `fx`, `fy`, `cx`, `cy` | Acquisition intrinsics, used to seed the camera solve and to build the rig/ROI geometry. |
| `truth` | The independent evaluation camera `{fx, fy, cx, cy}` — a different focal length from the acquisition camera. |
| `unitMm` | Millimetres per model unit; `100` for every scene (100 mm per unit, dataset card). |
| `direction`, `scanTopology` | Scan order (`top-down`) and the mesh topology (`ordered-horizontal`). |
| `provenance`, `coordinateSystem`, `limitations` | Human-readable provenance and the synthetic-accuracy caveat. |
| `lens` | `{model, coefficients}` — the simulated lens (the shipped data use `brown` with `[-0.18, 0.045, 0.001, -0.0015, -0.008]`). |
| `calibrationId`, `rigId` | The split this validation scene is compatible with; the worker refuses a mismatch. |
| `scene`, `name`, `object` | Scene id and display strings. |
| `acquisition` | `moving-board` or `fixed-board`; selects the calibration and plane model. |
| `lineCount` | Validation line count, checked against the frame array by the static tests. |
| `scanMotion` | Free-text description of the acquisition motion. |
| `validationTruth` | Optional shared truth volume path (fixed-board splits). |
| `download`, `downloadBytes`, `downloadFormat`, `downloadQuality` | Optional ZIP metadata; removed from the demo manifests because the archives are not shipped. |
| `objectDepth` | `[near, far]` working standoff in model units, rounded outward to 0.1 unit = 10 mm; feeds the search-band depth prior. |
| `objectBox` | `[xMin,xMax,yMin,yMax,zMin,zMax]` camera-frame AABB in model units, rounded outward to 10 mm; bounds the search columns. |
| `board` | ChArUco definition: `squares`, `squareLengthMm`, `markerLengthMm`, `dictionary`, `poseSource`, `fixedIntrinsics`. |
| `emitterBaselineMm` | Camera/laser baseline (248 mm upstream). |
| `emitterCamera` | Known fixed-board emitter position in model units (`[0, -2.0177, 1.4413]`). |
| `commandModel`, `modelNote`, `slopeBounds`, `commandBounds` | Fixed-board encoder-map metadata and the calibrated command ranges. |
| `boardMetrics` | Precomputed image-derived board observations: `reprojectionRmse`, `minCorners`, `minSpan`, `frameCount`. |
| `selection` | How the delivered frames were chosen from the candidates (candidate count, method, indices). |
| `channels`, `mono` | Present only on a monochrome split (`1` / `true`); see below. |
| `minimumBoardBorderPx`, `laserAppearance`, `scatteringModel` | Descriptive provenance for the moving-board border guarantee and the laser/scatter model. |

### Calibration frame entries

Each `manifest.calibration[i]` carries:

| Field | Meaning |
| --- | --- |
| `file` | Frame file name. |
| `t` | Scan parameter in `[0, 1]` (stage position for the moving board; sweep progress for the fixed board). |
| `command` | Fixed-board command index. |
| `commandPosition` | The recorded two-axis encoder position used to train the encoder map. |
| `boardPose` | Image-derived board observation `{plane, corners, …}` kept for independent audits; the reconstruction pose is re-solved by the worker, not taken from here. |
| `boardSpan`, `boardBorderPx` | The projected stripe span and the board border margin recorded by the generator. |
| `sha256` | Image hash provenance. |
| `candidateIndex` | Index in the generator's candidate pool. |

### Validation frame entries

Each `manifest.validation[i]` carries:

| Field | Meaning |
| --- | --- |
| `file` | Frame file name. |
| `t` | Scan parameter in `[0, 1]`. |
| `command` | Fixed-board command index; the worker maps it through the encoder model. |
| `commandPosition` | Two-axis encoder reading (fixed-board splits). |
| `translation` | Recorded rigid head displacement in model units; subtracted during triangulation (moving-board splits). |
| `stripeColumns` | The generator's count of stripe columns (provenance). |
| `truth` | Per-frame truth volume path (moving-board splits). |
| `sha256` | Image hash provenance. |

The browser worker buffers frames by URL and does **not** verify these hashes;
they exist so the offline `verify-*.py` tools can identify a release
(`tools/laser/make-mono-dataset.py` header).

## Truth volumes

A truth volume is a raw little-endian `Float32` array of `width × height`
depth values in model units (multiply by `unitMm` for millimetres), gzip
compressed as `*.f32.gz`. The worker fetches it through `DecompressionStream`
(the `get(..., 'buffer')` helper in `worker.js`) and samples it as described in
[SCAN-PIPELINE.md](SCAN-PIPELINE.md): bilinear interpolation with a
discontinuity guard, and it is loaded **only after** all displayed points
exist. The demo ships its small truth volumes so its manifests are complete
without the HD capture tree (`.gitignore` exception).

## `hd` versus `hd-mono`

The colour path is the default. The monochrome spike is opt-in with `?mono=1`:

- `app.js` computes `datasetBase` for the colour path from
  `demo/validation/...` and for the mono path from
  `hd-mono/validation/...` (the upstream website uses `hd/...` for the colour
  tree).
- The mono manifest copies the colour fields, adds `channels: 1` and
  `mono: true`, and rewrites each `truth` path as a relative link back to the
  colour directory (truth files are never copied).
- The worker detects the split from `manifest.channels === 1 || manifest.mono
  === true`, converts the RGBA pixels to one intensity byte per pixel, and
  uploads 2 MB instead of 8.3 MB per frame.
- The learned row gate is disabled on the mono path, and the kernel scores the
  pixel's own intensity rather than blue excess
  ([SCAN-PIPELINE.md](SCAN-PIPELINE.md)).

The parent doc records that the mono path does not yet pay off: without a
rendered monochrome sensor response the blue-excess ambient cancellation is
lost, and the colour path stays the default. The calibration board always stays
on the colour path.

## PLY export

`app.js` `savePly(data, name)` writes an ASCII PLY of the measured cloud and its
evaluation error, in millimetres:

```
ply
format ascii 1.0
comment NIDVUE synthetic validation reconstruction; units mm
element vertex <points>
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
property float error_mm
end_header
< x y z r g b error_mm > …
```

- Coordinates come from `result.points` (triangulated intersections only); the
  colours are the sampled image RGB; `error_mm` is the per-point Euclidean
  error, written as `-1` for unscored points.
- The decorative reference grid and the optional surface wireframe are **not**
  written — only recovered points (dataset card and
  [RENDERING.md](RENDERING.md)).
- The file name is `<calibrationId>-<scene>.ply`, e.g.
  `charuco-fixed-board-bin.ply`.

## Calibration exports

The completed calibration snapshot is exported three ways:

| Export | Button | File | Producer |
| --- | --- | --- | --- |
| JSON | `calibration-report` | `<dataset>-calibration.json` | `JSON.stringify(calibration, null, 2)` in `app.js` |
| Markdown | `calibration-markdown` | `<dataset>-calibration.md` | `calibrationMarkdown` in `calibration-report.js` |
| PowerPoint | `calibration-powerpoint` | `<dataset>-calibration.pptx` | `calibrationPowerpoint` in `calibration-report.js` |

The JSON object is the calibration result described in
[CALIBRATION.md](CALIBRATION.md): `dataset`, `rigId`, `version`, `config`,
`fit` (`[a, b, c, rms, inliers, samples]`), `camera` (intrinsics, model and
distortion coefficients), `boardMetrics`, `planeFits`, `encoderModel`
(fixed-board), `stripeRoi`, `calibrationFrames` and `completedAt`. The
Markdown/PPTX exports are generated from the same snapshot and carry the metric
and plane tables plus the honesty notice; they are documented in
[CALIBRATION.md](CALIBRATION.md).

## Units and coordinate conventions

- Model-unit geometry uses `unitMm = 100` mm/unit; the PLY and every reported
  metric are in millimetres.
- Camera coordinates are **X right, Y down, Z forward** (`coordinateSystem`).
- Pixel coordinates use the centre convention `(u + 0.5, v + 0.5)`; the
  detection code converts OpenCV's boundary origin by adding `0.5`
  (`board-pose.js`).
- The ChArUco plane is `Y + nx X + nz Z = d`; the search-band plane is
  `A X + Y + B Z = C` ([CALIBRATION.md](CALIBRATION.md)).

The GPL-3.0-or-later licence and the required attribution notice covering these
files are in [COMMERCIAL-USE.md](COMMERCIAL-USE.md) and
[`../NOTICE`](../NOTICE).
