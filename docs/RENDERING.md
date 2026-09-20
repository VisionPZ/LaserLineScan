<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com> -->

# Rendering

laser-line-scan has two independent drawing paths. The **frame renderer** re-renders
a reference capture under the designed illumination (step 00) and is the one
with a WebGPU → WebGL2 → CPU fallback chain. The **3D viewer**
([`../runtime/viewer.js`](../runtime/viewer.js), class `ScanViewer`) draws both
the procedural rig scene (step 01) and the measured point cloud (step 04). The
optics behind the colours is in [OPTICS-MODEL.md](OPTICS-MODEL.md); the
geometry of the calibration that feeds the rig is in
[CALIBRATION.md](CALIBRATION.md); the point data is in
[SCAN-PIPELINE.md](SCAN-PIPELINE.md) and [DATA-FORMATS.md](DATA-FORMATS.md).

## The frame renderer and its fallbacks

`spectralEngine()` in [`../runtime/spectral-gl.js`](../runtime/spectral-gl.js)
reports the best available tier:

1. **`'webgpu'`** when `navigator.gpu` exists;
2. **`'webgl2'`** when a `webgl2` context can be created;
3. **`'cpu'`** otherwise.

`applySpectralFrame(source, model, geometry, mode)` tries WebGPU
(`webgpuTransform`), then WebGL2 (`webgl2Transform`), and returns `null` when
neither engine can complete, so the caller can fall back to the CPU transform.
`app.js` `renderSpectralFrame` then draws the returned canvas, or — on `null` —
applies `applySpectral` from `spectral.js` directly to the image data. The
active engine is published as `root.dataset.spectralEngine`. All three tiers
evaluate the same expression from the same top-left row convention
(`dy = y + 0.5 − cy`), and the parent doc notes a browser test pins that
convention so an engine change re-renders a frame but cannot change it.

The **spectrum plot** is not a GPU pass: `spectral-plot.js` uses a crisp 2-D
canvas because the plot is small and needs readable tick text, leaving the GPU
budget to the frame transform. Its colours are read from the active theme
tokens at draw time and re-read when `data-theme` changes
([OPTICS-MODEL.md](OPTICS-MODEL.md)).

The **3D viewer** uses one WebGL context (`canvas.getContext('webgl', …)`) and
its shaders are GLSL ES 1.00; `ScanViewer` throws `browserError` when no WebGL
context is available, and `app.js` surfaces that as a browser error. There is no
CPU path for the 3D viewer. (The package [`README.md`](../README.md) lumps the
“spectral and viewer previews” together when describing the GPU fallbacks; in
the code the fallback chain belongs to the frame renderer above.)

## The point-cloud viewer

`ScanViewer` is instantiated twice in `app.js`: once for the result canvas
(`#ll-viewer`) and once for the rig canvas (`#ll-rig-viewer`). It keeps its
camera as yaw/pitch/zoom/pan and draws:

| Element | Detail |
| --- | --- |
| **Points** | The measured cloud, drawn with `gl.POINTS`; `pointSize` is adjustable and the fragment shader can turn each point into a soft round splat. |
| **Lighting normals** | Estimated from **adjacent recovered samples only** (neighbour differences, cross product, with a distance limit of `radius × 0.09`); no reference mesh is loaded. |
| **Surface mesh** | Optional wireframe built from horizontal and vertical neighbours of the ordered scan rows (`mesh()`), only when `scanTopology === 'ordered-horizontal'` and 32-bit indices are available. Horizontal gaps up to 48 columns are bridged when the surface step is small, so an occlusion shadow does not break the grid; a vertical link is only made within `radius × 0.12`. |
| **Reference grid** | A decorative dimensional grid at the cloud floor, drawn in `gl.LINES`. It is a visual aid and is **excluded from the PLY export**. |
| **Bounding box** | A yellow wireframe with a red dot at each of the eight vertices, toggled by the `bounding-box` control. |
| **Orientation gizmo** | Three coloured axes with cone arrowheads in the corner, rotated with the cloud; the `X`/`Y`/`Z` DOM labels track the projected axis tips. |

The reveal animation grows the drawn point count from `0` to `1` over about
1200 ms unless `prefers-reduced-motion: reduce` is set, in which case the cloud
appears at once.

### Display modes and colour modes

`app.js` maps the result controls onto `ScanViewer` state:

| Control | Values | Effect |
| --- | --- | --- |
| `render-mode` | `points`, `mesh` | `mode` — points or the optional wireframe. |
| `color` | `depth`, `rgb`, `error` | `color` — the vertex-shader colour mode (`colorMode`). |
| `point-size` | slider | `pointSize`, multiplied by the device pixel ratio and clamped to 2×. |
| `bounding-box` | checkbox | `showBox`. |
| `orbit` | button | `autoOrbit`, a slow automatic yaw. |

- **Depth** colours the cloud from a low warm-mint to a high violet.
- **RGB** uses the sampled image colour (gamma-adjusted in the shader).
- **Error** maps the per-point evaluation error onto a green→red ramp; unscored
  points (error `< 0`) are a neutral grey. The error scale is
  `max(rmse × 3, 0.01)`.

### Orbit, pan, zoom and presets

The viewer binds pointer, wheel and keyboard input (`ScanViewer.bind`):

- **Rotate:** primary-button drag (and one-finger drag) on the canvas.
- **Pan:** right-button drag, `Shift`-drag, or two-finger drag; pinch changes
  zoom.
- **Zoom:** wheel (exponential) and the toolbar `zoom-in`/`zoom-out`, clamped to
  `0.12 … 12`; the toolbar readout reports the zoom as a percentage.
- **Keyboard:** arrow keys rotate (or pan with `Shift`), `+`/`-` zoom, `Home`
  resets.
- **Presets:** `iso` (home), `front`, `top`, `side`, wired to the `home-view`,
  `front-view`, `top-view` and `side-view` buttons; each preset resets the
  camera and updates the pressed state. The rig has its own equivalent
  `rig-home-view`, `rig-front-view`, `rig-top-view`, `rig-side-view` buttons.

Interaction stops the automatic orbit (`stopOrbit`), and the axes labels can be
hidden independently.

## The rig scene

`buildRigScene(manifest, design)` in
[`../runtime/rig-scene.js`](../runtime/rig-scene.js) is a procedural scene, not
an imported model. It is driven by the selected calibration manifest's real
intrinsics and board:

- **Symmetric head.** The camera and the laser beams sit symmetrically about
  the head axis; the half-baseline and the working distance alone fix the tilt,
  `tan θ = (baseline / 2) / distance`. The module comment states that the camera
  and beam each sit **17.6°** from the surface normal, giving a **35°**
  triangulation, the same figures as `public/laser/DATASET-CARD.md`. The
  `rig-baseline` and `rig-distance` sliders drive it: `baseline` is clamped to
  `40 … 1200` and `distance` to `80 … 2000`, defaulting to the manifest's
  `emitterBaselineMm` (248 mm) and `objectDistanceMm` (388 mm) and updated from
  the calibration once it has run.
- **Camera and beamer.** The camera body is built on its optical axis; the
  bandpass filter sits in the optical path and is drawn only while the design
  engages it, coloured by the transmitted spectrum. The beamer body is built on
  its principal axis so that axis lies exactly in the projected sheet.
- **Board.** A real 8 × 6 ChArUco board whose dark cells are sampled from
  `../runtime/charuco-board.js`, the same texture the offline renderer uses.
- **Laser sheet.** A fan from the beamer aperture to the projected line (half
  the board width × 0.46), with a **6 mm rim** so a side-on preset still sees
  the sheet's edge instead of a vanishing zero-thickness triangle. The fan,
  the stripe and the beamer body share the sheet plane.
- **Camera field of view.** A translucent pyramid from the lens itself (not
  floating in front of it), with half-angles from the delivered intrinsics
  `atan((w/2)/fx)` and `atan((h/2)/fy)`, ending where the optical axis meets the
  board.
- **Colours from the design.** Ambient-lit surfaces are scaled by the ambient
  level and tinted by the ambient colour; the laser sheet, stripe and filter
  take the designed spectrum colours ([OPTICS-MODEL.md](OPTICS-MODEL.md)).

### Dimension rulers

`buildRigScene` returns two dimensions and `ScanViewer.setDimensions` renders
them:

| Id | Value | Anchors |
| --- | --- | --- |
| `baseline` | the camera-to-laser baseline (`baseline` mm) | camera position → laser origin |
| `object` | the head-to-object distance (`objectPin − headCentre`, mm) | head centre → object pin |

Each is drawn as a thin line with end ticks and solid end markers. The numeric
labels are DOM nodes in a `ll-dim-labels` overlay (`ScanViewer.dimRoot`);
`draw()` projects each dimension's world anchor with the same transform as the
vertex shader, so the label tracks the measurement as the rig turns, and hides
it when it leaves the view. `app.js` formats each value with the locale
(`formats.number(d.value, 0)`) and gives it the `rigBaseline`/`rigDistance`
title.

## Fullscreen

`app.js` registers three fullscreen targets (`fullscreenTargets`):

| Button | Panel |
| --- | --- |
| `calibration-fullscreen` | `calibration-scan` |
| `validation-fullscreen` | `validation-scan` |
| `fullscreen` | `viewer-panel` |

The buttons are hidden when `document.fullscreenEnabled` is false. Clicking one
toggles `requestFullscreen`/`exitFullscreen` on its panel. On
`fullscreenchange` the code marks the matching button `aria-pressed`, swaps its
icon and label between fullscreen/exit, and redraws the viewer so the canvas
resizes for the new viewport. Scan controls, progress and cancel stay usable in
fullscreen, and completion automatically leaves fullscreen before focusing the
calibration metrics (`leaveScanFullscreen`). The 2-D frame previews
(`image-preview.js`) also support native fullscreen with zoom, drag-to-pan,
90° rotation and reset, and never alter the acquisition pixels or the worker's
coordinates.

The licence terms for the UI are in
[COMMERCIAL-USE.md](COMMERCIAL-USE.md); the UI audit that drove these decisions
is the parent `docs/LASER-UI-AUDIT.md`.
