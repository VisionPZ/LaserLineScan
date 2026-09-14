<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com> -->

# Optics model (step 00)

Step 00 designs the illumination and the detection chain before any frame is
scanned. The model lives in [`../runtime/spectral.js`](../runtime/spectral.js),
is plotted by [`../runtime/spectral-plot.js`](../runtime/spectral-plot.js), and
is applied to frames by [`../runtime/spectral-gl.js`](../runtime/spectral-gl.js).
The same model exists offline as the upstream `tools/laser/spectral.py`, so the
page, the scan worker and the renderer share one description
(`docs/LASER-CALIBRATION.md`). The design drives the rig scene
([RENDERING.md](RENDERING.md)) and the per-pixel shading of every frame
([SCAN-PIPELINE.md](SCAN-PIPELINE.md)).

## Wavelength grid

Everything integrates over the silicon response band:

| Constant | Value | Source |
| --- | --- | --- |
| `STEP` | `1` nm | `spectral.js` |
| `LAMBDA_MIN` | `380` nm | `spectral.js` |
| `LAMBDA_MAX` | `1000` nm | `spectral.js` |
| `BAND_COUNT` | `(1000 − 380) / 1 + 1 = 621` samples | `spectral.js` |

The parent documentation states the same grid: “models the illumination and
detection chain by wavelength (1 nm steps over 380-1000 nm, the silicon
response band)”. `integrate(spd, transmission, qe, reflectance)` sums the
product over the grid and multiplies by `STEP`; `integrateRgb` does the same per
Bayer channel.

## Laser diode model

`laserDiode(center, fwhm, modes, spacing)` builds a Gaussian envelope carrying
discrete longitudinal modes. Because a diode line is far narrower than the 1 nm
grid, each mode deposits its envelope-weighted power into the **two nearest
bands by distance** rather than being sampled on the grid (the `laserDiode`
comment: “a 532 nm line falls between 5 nm samples”). The result is normalised
to its own peak. The reference design the HD dataset was rendered with is
`NOMINAL_LASER = {center: 450, fwhm: 2, modes: 5, spacing: 0.42}`
(`spectral.js`).

The catalogue (`LASER_PRESETS`, `LASER_ORDER`) is generated from the same
registry the model reads:

| Preset | Centre | FWHM | Modes |
| --- | ---: | ---: | ---: |
| `violet405` | 405 nm | 2 nm | 5 |
| `blue450` | 450 nm | 2 nm | 5 |
| `cyan488` | 488 nm | 1.5 nm | 3 |
| `green520` | 520 nm | 1.5 nm | 3 |
| `green532` | 532 nm | 0.4 nm | 1 |
| `red635` | 635 nm | 2 nm | 5 |
| `red660` | 660 nm | 2 nm | 5 |
| `nir850` | 850 nm | 2 nm | 5 |

Only the two fine adjustments `laser-fwhm` and `laser-modes` are editable in
the panel; the centre comes from the selected diode (`app.js`
`applyPreset('laser', …)`).

## Lens bandpass filter and its angle shift

`bandpass(cwl, fwhm, tpeak, od, order = 4)` is a hard-coated laser-line filter:
a super-Gaussian passband of order 4 with the stated peak transmission `tpeak`,
floored at an out-of-band leakage of `tpeak / 10^od` (`od` is the optical
density). The centre wavelength is **not** a free parameter of the model — it
follows the designed laser line, so a 520 nm or 660 nm design shifts the
coating (`spectralModel`; see also the parent note that the passband follows
the designed line, including a hand-drawn laser spectrum, via `lineCenter`).

`shiftedCwl(cwl, incidenceDeg, nEff = FILTER_N_EFF)` applies the
interference-filter incidence-angle blue shift,
`λ(θ) = λ₀ · √(1 − (sin θ / n_eff)²)`, with
`FILTER_N_EFF = 1.85` (`spectral.js`). `bandpassAngled` re-centres the passband
at that shifted wavelength.

| Preset (`FILTER_PRESETS`) | FWHM | Peak | OD | Engaged |
| --- | ---: | ---: | ---: | --- |
| `standard40` | 40 nm | 0.93 | 5 | yes |
| `narrow25` | 25 nm | 0.95 | 5 | yes |
| `narrow10` | 10 nm | 0.92 | 6 | yes |
| `wide80` | 80 nm | 0.92 | 4 | yes |
| `uvircut` | 400 nm | 0.97 | 4 | yes |
| `none` | 40 nm | 0.93 | 5 | no |

Industrial reference numbers from the parent `docs/LASER-CALIBRATION.md`:
a **450/40** filter (peak 0.93, OD 5) passes **93%** of the laser line and
**10.4%** of the 5000 K LED ambient — an **8.9×** contrast gain; at **30°**
the passband shifts to **433 nm** and the laser falls to **66%**, so the line
dims to about **47%** at the frame corners. `spectralModel` returns the
corresponding computed terms `laserTransmission`, `ambientTransmission`,
`contrastGain`, `cornerTransmission` and `filterCenterAt30`.

## Sensor quantum-efficiency presets

`sensorQe(key)` interpolates a digitised relative-response curve;
`sensorRgbQe(key)` multiplies the curve by a reference colour-filter-array
(CFA) response for the B/G/R channels. The curves are **approximations**:
`SENSOR_PRESETS` documents them as digitised from published relative-response
graphs, reproducing the shape and peak quantum efficiency of each family, *not*
certified data — a production design must use the manufacturer's measurement
(the `source` field records each curve's family).

| Preset | Family |
| --- | --- |
| `imx174` | Sony Pregius IMX174 mono |
| `imx264` | Sony Pregius IMX264 mono |
| `imx264llr` | Sony Pregius IMX264LLR mono (extended NIR) |
| `imx250mzr` | Sony IMX250MZR polarisation mono |
| `imx178` | Sony STARVIS IMX178 mono |
| `python5000` | onsemi PYTHON 5000 mono |
| `imx264c` | Sony Pregius IMX264 colour (Bayer) |

`SENSOR_ORDER` fixes the panel order. Only `imx264c` sets `colour: true`; mono
presets fall back to the reference CFA in `sensorRgbQe`.

## Ambient sources

`ambientSpd(key)` builds a Planck black-body spectrum at the source's colour
temperature (`planck`), adds a blue pump and any gas-discharge emission lines,
then peak-normalises the shape so every series shares one plot magnitude axis.
The scene level is separate from the shape and scales the ambient-lit pixels.

| Preset (`AMBIENT_PRESETS`) | CCT | Level | Notes |
| --- | ---: | ---: | --- |
| `led5000` | 5000 K | 1 | reference office LED |
| `led3000` | 3000 K | 0.9 | warm LED, blue pump 0.22 |
| `daylight` | 6500 K | 1.3 | `daylight 1.3` (parent doc) |
| `fluorescent` | 4200 K | 0.85 | tri-phosphor with mercury lines (405/436/546/577/611 nm) |
| `halogen` | 2900 K | 0.7 | `halogen 0.7` (parent doc) |
| `highbay` | 4000 K | 1.1 | industrial high-bay |
| `dark` | 4200 K | 0.05 | `dark room 0.05` (parent doc) |

Three ambient terms are derived in `spectralModel`:

- `ambientYield` — how much of the ambient the sensor collects relative to the
  undrawn source, `integrate(edited) / integrate(preset)`; an unedited
  spectrum yields exactly `1`, so only a hand-drawn curve changes visibility.
- `ambientTint` — peak-normalised ratio of the ambient's colour to the
  reference `led5000` source, so a tungsten room warms the board and a
  fluorescent one tints it green (`ambientRgb`).
- `ambientLevel` — the scene illuminance from the preset, overridable by the
  `ambient-level` slider.

The parent `docs/LASER-CALIBRATION.md` notes that the level scales every
ambient-lit pixel and the colour tints it, “so choosing a source demonstrably
changes the brightness of the calibration board … the laser stripe is
self-luminous and does not follow”.

## Effective stripe colour and contrast gain

Two derived quantities drive the capture transform and the step-00 metric row:

- **Effective stripe colour (`stripeColor`).** The reference dataset tint is
  `NOMINAL_STRIPE = [0.015, 0.12, 1.0]` (`spectral.js`). `spectralModel`
  re-colours it by an **additive** shift toward the designed laser's own
  spectral colour and renormalises:
  `stripe = NOMINAL_STRIPE + designed − nominal`, then divided by its peak.
  The parent doc explains the choice: an additive shift vanishes at the
  reference design, so the identity reproduces the dataset byte for byte, while
  a 520 nm design reads green rather than a blue-tinted mint.
- **Contrast gain (`contrastGain`).** The laser-to-ambient ratio after the
  filter, normalised by the unfiltered ratio:
  `(laserPass / ambientPass) / (laserTotal / ambientTotal)`.
  `laserTransmission = laserPass / laserTotal` and
  `ambientTransmission = ambientPass / ambientTotal` are reported alongside it.
  `cornerTransmission` is the last sample of the 91-point `angleCurve`
  (normal-incidence-normalised laser transmission at the maximum field angle).

`app.js` (`gradeSpectral`) grades the panel against the documented targets:

| Metric | Green | Amber | Source |
| --- | --- | --- | --- |
| `laserTransmission` (`s-laser`) | ≥ 0.90 | ≥ 0.70 | `app.js` |
| `ambientTransmission` (`s-ambient`) | ≤ 0.15 | ≤ 0.30 | `app.js` |
| `contrastGain` (`s-contrast`) | ≥ 5 | ≥ 3 | `app.js` |
| corner field transmission (`s-corner`) | ≥ 0.40 | ≥ 0.25 | `app.js` |

## The capture transform: `reference` and `filtered`

`transformSpec(model, geometry, mode)` turns the design into the numbers a
renderer or the scan worker applies. It has two modes:

- **`reference`** — the calibration capture: the ambient-lit scene with no
  bandpass. `ambient = ambientLevel × ambientYield`, `laser = 1`, and the
  angle curve is flat (`REFERENCE_CURVE`), so brightness follows only the
  designed ambient level and tint.
- **`filtered`** — the object scan: `ambient` is additionally multiplied by
  `ambientTransmission`, `laser = laserTransmission`, and the curve is the
  designed `angleCurve`.

`applySpectral(pixels, spec)` is the CPU implementation (WebGL2/WebGPU
implementations live in `spectral-gl.js`). Per pixel it recovers the blue-excess
scalar `s = max(0, b − max(r, g))`, removes the nominal stripe to get the base
colour, and writes

```
base × ambient × tint  +  s × laser × gainAt(radius) × stripeColor
```

so the ambient-lit surfaces follow the source level and tint while the
self-luminous stripe carries the designed colour and the per-pixel
incidence-angle gain. `transmissionAt(model, deg)` and the kernel's field do
the same lookup on the 91-sample `angleCurve`, indexed over `0…maxAngle`
(default `45°`).

`spectral-gl.js` implements the same expression three ways and reports which
engine ran: `spectralEngine()` returns `'webgpu'` when `navigator.gpu` exists,
else `'webgl2'` when a WebGL2 context can be created, else `'cpu'`.
`applySpectralFrame` tries WebGPU, then WebGL2, and returns `null` so the
caller can fall back to `applySpectral`. The parent doc pins the convention:
all engines evaluate the same expression from the same top-left row convention
(`dy = y + 0.5 − cy`), and `tests/` pins the kernel implementation to
`applySpectral()` across six designs.

## The spectrum plot and its editable control points

`spectral-plot.js` draws a 2-D canvas (not a GPU pass) with a wavelength axis,
a shared relative magnitude axis and a dim grid. It draws the laser line, the
filter passband, the ambient, the sensor response and the detected signal
(laser × filter × sensitivity) from the active theme tokens, re-read whenever
`data-theme` changes. Tick values are language-independent; titles and legend
come from the locale copy.

Every source curve is editable, and the edit is a replacement for that series:

- A right click on a curve adds a control point at the wavelength under the
  cursor holding the curve's current value, so the shape does not jump.
- A left drag moves a point, clamped between its neighbours and to the shared
  magnitude axis.
- A right click on a point offers to add a point on the next segment or delete
  it.

`app.js` keeps one override array per series (`curveOverrides`); the first edit
seeds knots from the current model curve with a Douglas–Peucker simplification
(`controlPointsFor(curve, tolerance = 0.012)`), so the curve is preserved while
it is edited and the model curve returns once the knots are removed
(`deleteCurvePoint` clears the override below two knots). `curveFromPoints`
is a **monotone cubic Hermite** interpolant, so a drawn curve never overshoots
a value the user placed. Changing a group's own controls or Restore defaults
discards the hand-drawn curve for that series (`clearCurveOverride`). For the
laser series, `lineCenter` places the filter passband on the strongest knot of
a hand-drawn spectrum, so a drawn 520 nm line moves the coating exactly as the
green preset does.

## Where the model is used

- The **scan worker** receives `config.spectral` (exactly the `transformSpec`
  numbers for the canvas) and applies the kernel transform before detection, so
  the corner detector and the stripe extractor read the frame the user reviewed
  ([SCAN-PIPELINE.md](SCAN-PIPELINE.md)).
- The **frame previews** re-render the reference capture with the current
  design in steps 01–03.
- The **rig scene** takes the designed laser colour, stripe colour, filter
  colour and ambient level/tint ([RENDERING.md](RENDERING.md)).
- After a scan exists, the illumination is locked (`spectralLocked` in
  `app.js`), because changing it would invalidate the displayed point cloud.

The licence terms covering all of this are in
[COMMERCIAL-USE.md](COMMERCIAL-USE.md); the test coverage is described in
[TESTING.md](TESTING.md).
