// SPDX-License-Identifier: GPL-3.0-or-later

/* Spectral illumination and camera-response model, shared by the lab UI, the
 * scan worker and the node tests. It mirrors tools/laser/spectral.py so the
 * offline renderer and the browser agree:
 *
 *   - typical ambient sources (LED, daylight, fluorescent, halogen, dark);
 *   - typical laser diodes (violet to near-infrared) as a Gaussian envelope
 *     carrying discrete longitudinal modes;
 *   - typical hard-coated bandpass filters with a stated FWHM, peak
 *     transmission and out-of-band optical density, including the
 *     interference-filter incidence-angle blue shift;
 *   - typical camera sensitivity responses (mono BSI/FSI, NIR-enhanced,
 *     scientific CMOS, colour Bayer).
 *
 * Everything integrates over 380-1000 nm at 1 nm steps. `spectralModel()`
 * returns the derived quantities the UI shows and the renderers apply.
 */

export const STEP = 1;
export const LAMBDA_MIN = 380;
export const LAMBDA_MAX = 1000;
export const BAND_COUNT = (LAMBDA_MAX - LAMBDA_MIN) / STEP + 1;
export const WAVELENGTHS = Float64Array.from({length: BAND_COUNT}, (_, i) => LAMBDA_MIN + i * STEP);

// The stripe tint the HD dataset was rendered with. The spectral transform is
// expressed relative to it, so the identity model reproduces the dataset.
export const NOMINAL_STRIPE = [0.015, 0.12, 1.0];
export const NOMINAL_LASER = {center: 450, fwhm: 2, modes: 5, spacing: 0.42};
export const FILTER_N_EFF = 1.85;

const ONES = WAVELENGTHS.map(() => 1);
const LOG2 = Math.log(2);

/* ----------------------------------------------------------------- sources */

/** Typical ambient sources. `lines` are gas-discharge emission lines (nm, weight). */
/**
 * Typical ambient sources. `level` is the scene illuminance relative to a
 * 5000 K LED office, so choosing a source also changes how bright the captured
 * scene is; `lines` are gas-discharge emission lines (nm, weight).
 */
export const AMBIENT_PRESETS = {
  led5000: {cct: 5000, pump: 0.18, lines: null, level: 1},
  led3000: {cct: 3000, pump: 0.22, lines: null, level: 0.9},
  daylight: {cct: 6500, pump: 0.05, lines: null, level: 1.3},
  fluorescent: {cct: 4200, pump: 0.03, level: 0.85,
    lines: [[405, 0.30], [436, 0.70], [546, 1.00], [577, 0.45], [611, 0.16]]},
  halogen: {cct: 2900, pump: 0, lines: null, level: 0.7},
  highbay: {cct: 4000, pump: 0.12, lines: null, level: 1.1},
  dark: {cct: 4200, pump: 0.03, lines: null, level: 0.05},
};

export const AMBIENT_ORDER = ['led5000', 'led3000', 'daylight', 'fluorescent', 'halogen', 'highbay', 'dark'];

/** Typical laser diodes. Fabry-Perot diodes carry several modes; DPSS is single. */
export const LASER_PRESETS = {
  violet405: {center: 405, fwhm: 2, modes: 5},
  blue450: {center: 450, fwhm: 2, modes: 5},
  cyan488: {center: 488, fwhm: 1.5, modes: 3},
  green520: {center: 520, fwhm: 1.5, modes: 3},
  green532: {center: 532, fwhm: 0.4, modes: 1},
  red635: {center: 635, fwhm: 2, modes: 5},
  red660: {center: 660, fwhm: 2, modes: 5},
  nir850: {center: 850, fwhm: 2, modes: 5},
};

export const LASER_ORDER = ['violet405', 'blue450', 'cyan488', 'green520', 'green532', 'red635', 'red660', 'nir850'];

/** Typical laser-line bandpass filters. The centre always follows the laser. */
export const FILTER_PRESETS = {
  none: {fwhm: 40, tpeak: 0.93, od: 5, enabled: false},
  narrow10: {fwhm: 10, tpeak: 0.92, od: 6, enabled: true},
  narrow25: {fwhm: 25, tpeak: 0.95, od: 5, enabled: true},
  standard40: {fwhm: 40, tpeak: 0.93, od: 5, enabled: true},
  wide80: {fwhm: 80, tpeak: 0.92, od: 4, enabled: true},
  uvircut: {fwhm: 400, tpeak: 0.97, od: 4, enabled: true},
};

export const FILTER_ORDER = ['standard40', 'narrow25', 'narrow10', 'wide80', 'uvircut', 'none'];

/** Industrial camera sensors.
 *
 *  The curves are approximations: they are digitised from the relative-response
 *  graphs published for each part, sampled at the knots below and interpolated
 *  over the 1 nm band. They reproduce the shape and the peak quantum efficiency
 *  of the sensor family, not certified values, so a production design must use
 *  the manufacturer's measurement for the actual sensor, lens and coating. The
 *  `source` field records the family each curve came from.
 */
export const SENSOR_PRESETS = {
  // Sony Pregius, 1/1.2 in, 1936x1216, 5.86 um, global shutter, mono.
  imx174: {source: 'Sony Pregius IMX174 mono', curve: [
    [380, .30], [400, .45], [420, .55], [450, .66], [475, .73], [500, .77], [525, .79],
    [550, .77], [575, .73], [600, .69], [650, .57], [700, .44], [750, .30], [800, .19],
    [850, .10], [900, .05], [950, .02], [1000, .01]]},
  // Sony Pregius, 2/3 in, 2448x2048, 3.45 um, global shutter, mono.
  imx264: {source: 'Sony Pregius IMX264 mono', curve: [
    [380, .20], [400, .33], [420, .44], [450, .55], [475, .61], [500, .64], [525, .66],
    [550, .65], [575, .62], [600, .59], [650, .49], [700, .37], [750, .25], [800, .15],
    [850, .08], [900, .04], [950, .02], [1000, .01]]},
  // Same die with the low-light / extended-NIR coating.
  imx264llr: {source: 'Sony Pregius IMX264LLR mono, extended NIR', curve: [
    [380, .18], [400, .30], [420, .40], [450, .51], [475, .57], [500, .61], [525, .63],
    [550, .63], [575, .62], [600, .60], [650, .55], [700, .50], [750, .45], [800, .40],
    [850, .32], [900, .22], [950, .12], [1000, .06]]},
  // IMX250 die behind an on-chip four-direction polariser, so the response is
  // the mono curve reduced by the polariser's transmission.
  imx250mzr: {source: 'Sony IMX250MZR polarisation mono', curve: [
    [380, .15], [400, .25], [420, .33], [450, .41], [475, .46], [500, .48], [525, .50],
    [550, .49], [575, .47], [600, .44], [650, .37], [700, .28], [750, .19], [800, .11],
    [850, .06], [900, .03], [1000, .01]]},
  // Sony STARVIS back-illuminated, 1/1.8 in, 3096x2076, 2.4 um, rolling shutter.
  imx178: {source: 'Sony STARVIS IMX178 mono', curve: [
    [380, .30], [400, .50], [420, .62], [450, .72], [475, .77], [500, .80], [550, .82],
    [600, .82], [650, .79], [700, .72], [750, .62], [800, .50], [850, .36], [900, .22],
    [950, .11], [1000, .05]]},
  // onsemi PYTHON, 1 in, 2592x2048, 4.8 um, global shutter, mono, wide NIR.
  python5000: {source: 'onsemi PYTHON 5000 mono', curve: [
    [380, .25], [400, .38], [420, .47], [450, .55], [475, .59], [500, .61], [525, .62],
    [550, .61], [575, .60], [600, .58], [650, .55], [700, .52], [750, .49], [800, .45],
    [850, .37], [900, .26], [950, .15], [1000, .07]]},
  // The same die behind a Bayer colour filter array: the mosaic transmits about
  // three quarters of the incident light once its passbands are averaged.
  imx264c: {source: 'Sony Pregius IMX264 colour (Bayer)', colour: true, curve: [
    [380, .14], [400, .24], [420, .32], [450, .40], [475, .44], [500, .46], [525, .48],
    [550, .47], [575, .45], [600, .42], [650, .35], [700, .27], [750, .18], [800, .11],
    [850, .06], [900, .03], [950, .01], [1000, .00]]},
};

export const SENSOR_ORDER = ['imx174', 'imx264', 'imx264llr', 'imx250mzr', 'imx178', 'python5000', 'imx264c'];

const CFA = {
  B: [[380, .05], [400, .25], [450, .60], [480, .55], [520, .12], [600, .02], [700, .01], [780, .005], [900, .004], [1000, .003]],
  G: [[380, .05], [420, .18], [480, .35], [540, .68], [580, .72], [640, .40], [720, .10], [780, .04], [900, .02], [1000, .01]],
  R: [[380, .01], [480, .02], [560, .12], [600, .45], [640, .68], [700, .45], [780, .18], [900, .06], [1000, .02]],
};

/* -------------------------------------------------------------- primitives */

export function planck(nm, temperature) {
  const h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23;
  const lambda = nm * 1e-9;
  return (2 * h * c ** 2 / lambda ** 5) / (Math.expm1(h * c / (lambda * k * temperature)));
}

function table(table, nm) {
  if (nm <= table[0][0]) return table[0][1];
  if (nm >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 1; i < table.length; i++) {
    if (nm > table[i][0]) continue;
    const [x0, y0] = table[i - 1], [x1, y1] = table[i];
    return y0 + (y1 - y0) * (nm - x0) / (x1 - x0);
  }
  return table[table.length - 1][1];
}

export function ambientSpd(key = 'led5000') {
  const preset = AMBIENT_PRESETS[key] || AMBIENT_PRESETS.led5000;
  const raw = WAVELENGTHS.map(nm => planck(nm, preset.cct));
  const peak = Math.max(...raw);
  const lineWidth = 3.5;
  const spd = Float64Array.from(raw, (value, i) => {
    let out = value / peak + preset.pump * Math.exp(-0.5 * ((WAVELENGTHS[i] - 452) / 28) ** 2);
    if (preset.lines)
      for (const [nm, weight] of preset.lines)
        out += weight * Math.exp(-0.5 * ((WAVELENGTHS[i] - nm) / lineWidth) ** 2);
    return out;
  });
  // Normalise the shape so the plot shares one magnitude axis; the level only
  // scales the rejected power and cancels out of every transmission ratio.
  const shape = Math.max(...spd) || 1;
  return Float64Array.from(spd, value => value / shape);
}

export function laserDiode(center = 450, fwhm = 2, modes = 5, spacing = 0.42) {
  // A diode line is far narrower than one band, so sampling the line shape on
  // the grid would alias it (a 532 nm line falls between 5 nm samples). Each
  // mode deposits its envelope-weighted power into the two nearest bands by
  // distance, which also interpolates a smooth filter transmission exactly.
  const spd = new Float64Array(BAND_COUNT);
  const powers = Array.from({length: modes}, (_, i) => Math.exp(-0.5 * (i - (modes - 1) / 2) ** 2));
  const sigma = fwhm / 2.3548;
  powers.forEach((power, i) => {
    const c = center + (i - (modes - 1) / 2) * spacing;
    const weight = power * Math.exp(-0.5 * ((c - center) / sigma) ** 2);
    const t = (c - LAMBDA_MIN) / STEP, i0 = Math.floor(t), f = t - i0;
    if (i0 >= 0 && i0 < BAND_COUNT) spd[i0] += weight * (1 - f);
    if (i0 + 1 >= 0 && i0 + 1 < BAND_COUNT) spd[i0 + 1] += weight * f;
  });
  let peak = 0;
  for (let b = 0; b < BAND_COUNT; b++) if (spd[b] > peak) peak = spd[b];
  const scale = peak > 0 ? 1 / peak : 1;
  for (let b = 0; b < BAND_COUNT; b++) spd[b] *= scale;
  return spd;
}

export function bandpass(cwl = 450, fwhm = 40, tpeak = 0.93, od = 5, order = 4) {
  const floor = tpeak / 10 ** od;
  return Float64Array.from(WAVELENGTHS, nm => {
    const value = tpeak * Math.exp(-LOG2 * (2 * Math.abs(nm - cwl) / fwhm) ** order);
    return Math.max(value, floor);
  });
}

/** The same filter at an oblique incidence angle: lambda0 shifts short. */
export function shiftedCwl(cwl, incidenceDeg, nEff = FILTER_N_EFF) {
  const theta = incidenceDeg * Math.PI / 180;
  return cwl * Math.sqrt(Math.max(1e-6, 1 - (Math.sin(theta) / nEff) ** 2));
}

/* ------------------------------------------------------- editable curves */

/**
 * Monotone cubic Hermite interpolation of hand-placed knots over the band.
 * A control point is {nm, value}; the result is clamped to [0, 1] because every
 * series shares one magnitude axis. Values outside the knot range are held flat,
 * and the interpolant never overshoots a local maximum the user drew, which is
 * what makes dragging a knot feel like shaping a measured curve.
 */
export function curveFromPoints(points) {
  const knots = (points || []).slice().sort((a, b) => a.nm - b.nm);
  const out = new Float64Array(BAND_COUNT);
  if (!knots.length) return out;
  if (knots.length === 1) { out.fill(clamp01(knots[0].value)); return out; }
  const n = knots.length;
  const h = new Float64Array(n - 1), delta = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(1e-6, knots[i + 1].nm - knots[i].nm);
    delta[i] = (knots[i + 1].value - knots[i].value) / h[i];
  }
  const m = new Float64Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  let segment = 0;
  for (let b = 0; b < BAND_COUNT; b++) {
    const nm = WAVELENGTHS[b];
    if (nm <= knots[0].nm) { out[b] = clamp01(knots[0].value); continue; }
    if (nm >= knots[n - 1].nm) { out[b] = clamp01(knots[n - 1].value); continue; }
    while (segment < n - 2 && nm > knots[segment + 1].nm) segment++;
    const t = (nm - knots[segment].nm) / h[segment];
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
    out[b] = clamp01(h00 * knots[segment].value + h10 * h[segment] * m[segment]
      + h01 * knots[segment + 1].value + h11 * h[segment] * m[segment + 1]);
  }
  return out;
}

/** A compact knot set that reproduces a curve within `tolerance` in magnitude. */
export function controlPointsFor(curve, tolerance = 0.012) {
  const points = Array.from(WAVELENGTHS, (nm, b) => ({nm, value: curve[b]}));
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const slope = (points[b].value - points[a].value) / (points[b].nm - points[a].nm || 1);
    let worst = 0, index = -1;
    for (let i = a + 1; i < b; i++) {
      const line = points[a].value + slope * (points[i].nm - points[a].nm);
      const distance = Math.abs(points[i].value - line);
      if (distance > worst) { worst = distance; index = i; }
    }
    if (worst > tolerance && index > a) { keep[index] = 1; stack.push([a, index], [index, b]); }
  }
  return points.filter((_, i) => keep[i]).map(p => ({nm: p.nm, value: p.value}));
}

/** The hand-drawn knots when there are enough to define a curve, else null. */
export function editedCurve(points) {
  return points && points.length >= 2 ? curveFromPoints(points) : null;
}

/**
 * The designed line's own wavelength: the strongest knot of a hand-drawn
 * spectrum. The coating's passband is placed here, so drawing a 520 nm line
 * moves the band off 450 nm the way choosing the green preset does.
 */
function lineCenter(points, fallback) {
  let best = null;
  for (const point of points || []) if (!best || point.value > best.value) best = point;
  return best && best.value > 0 ? best.nm : fallback;
}

const clamp01 = value => value < 0 ? 0 : value > 1 ? 1 : value;
const active = points => points && points.length >= 2 ? points : null;

export function bandpassAngled(cwl, fwhm, tpeak, od, incidenceDeg, nEff = FILTER_N_EFF, order = 4) {
  return bandpass(shiftedCwl(cwl, incidenceDeg, nEff), fwhm, tpeak, od, order);
}

export function sensorQe(key = 'imx174') {
  const preset = SENSOR_PRESETS[key] || SENSOR_PRESETS.imx174;
  return Float64Array.from(WAVELENGTHS, nm => table(preset.curve, nm));
}

/** Colour response of the capture. Mono presets fall back to the reference CFA. */
export function sensorRgbQe(key = 'imx174') {
  const preset = SENSOR_PRESETS[key] || SENSOR_PRESETS.imx174;
  const out = {};
  for (const channel of ['B', 'G', 'R']) {
    const cfa = CFA[channel];
    out[channel] = Float64Array.from(WAVELENGTHS, nm => {
      const base = preset.colour ? table(preset.curve, nm) : 1;
      return table(cfa, nm) * base;
    });
  }
  return out;
}

/* --------------------------------------------------------------- integrals */

export function integrate(spd, transmission, qe, reflectance = null) {
  let sum = 0;
  for (let b = 0; b < BAND_COUNT; b++)
    sum += spd[b] * transmission[b] * qe[b] * (reflectance ? reflectance[b] : 1);
  return sum * STEP;
}

export function integrateRgb(spd, transmission, qeRgb, reflectance = null) {
  return {
    R: integrate(spd, transmission, qeRgb.R, reflectance),
    G: integrate(spd, transmission, qeRgb.G, reflectance),
    B: integrate(spd, transmission, qeRgb.B, reflectance),
  };
}

function normalizeRgb(rgb) {
  const peak = Math.max(rgb.R, rgb.G, rgb.B) || 1;
  return [rgb.R / peak, rgb.G / peak, rgb.B / peak];
}

export function laserRgb(laser, filter, cfa) {
  return normalizeRgb(integrateRgb(laser, filter, cfa || sensorRgbQe()));
}

/** The ambient's own colour as the colour sensor sees it. */
export function ambientRgb(spd, cfa) {
  return normalizeRgb(integrateRgb(spd, ONES, cfa || sensorRgbQe()));
}

/** The dataset's own illumination: a 450 nm multi-mode diode with no filter. */
export function nominalModel() {
  const laser = laserDiode(NOMINAL_LASER.center, NOMINAL_LASER.fwhm, NOMINAL_LASER.modes, NOMINAL_LASER.spacing);
  return {filter: Float64Array.from(ONES), laserRgb: laserRgb(laser, ONES)};
}

/** Per-angle laser transmission through the filter, normalised to 1 at 0 deg. */
export function angleCurve(cwl, fwhm, tpeak, od, {degrees = 45, samples = 91, nEff = FILTER_N_EFF, sensor = 'imx174', laser = null} = {}) {
  const probe = laser || laserDiode(NOMINAL_LASER.center, NOMINAL_LASER.fwhm, NOMINAL_LASER.modes, NOMINAL_LASER.spacing);
  const qe = sensorQe(sensor);
  const reference = integrate(probe, bandpass(cwl, fwhm, tpeak, od), qe) || 1;
  const curve = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    const deg = degrees * i / (samples - 1);
    curve[i] = integrate(probe, bandpassAngled(cwl, fwhm, tpeak, od, deg, nEff), qe) / reference;
  }
  return curve;
}

/* ------------------------------------------------------------------- model */

/**
 * Derive everything the UI and the renderers need from a design.
 * `filterEnabled:false` removes the filter, which is the dataset's baseline and
 * therefore the identity transform.
 */
export function spectralModel(params = {}, overrides = {}) {
  const {
    center = 450, fwhm = 2, modes = 5, spacing = 0.42,
    filterFwhm = 40, filterPeak = 0.93, filterOd = 5, filterEnabled = true,
    ambient = 'led5000', sensor = 'imx174', nEff = FILTER_N_EFF,
  } = params;
  // The ambient source carries both a spectrum and a scene level. The level
  // scales every ambient-lit pixel, which is what makes the board and the
  // captures brighten or darken with the chosen source.
  const ambientPreset = AMBIENT_PRESETS[ambient] || AMBIENT_PRESETS.led5000;
  const ambientLevel = Number.isFinite(params.ambientLevel) ? params.ambientLevel : ambientPreset.level;
  // Hand-placed control points replace the model curve for that series.
  const laserKnots = active(overrides.laser);
  const laser = editedCurve(laserKnots) || laserDiode(center, fwhm, modes, spacing);
  // The coating is chosen to sit on the line it passes, so it follows the
  // designed line: a hand-drawn spectrum moves the passband exactly as picking
  // a 520 nm or 660 nm preset does. Without this the drawn design would be
  // blocked by the preset's band and the effective stripe colour would keep
  // reporting that band's own leak instead of the designed line.
  const bandCenter = laserKnots ? lineCenter(laserKnots, center) : center;
  const baseFilter = filterEnabled ? bandpass(bandCenter, filterFwhm, filterPeak, filterOd) : Float64Array.from(ONES);
  const baseQe = sensorQe(sensor);
  const filter = editedCurve(overrides.filter) || baseFilter;
  const ambientSpdCurve = editedCurve(overrides.ambient) || ambientSpd(ambient);
  const qe = editedCurve(overrides.qe) || baseQe;
  const cfa = sensorRgbQe(sensor);
  if (overrides.qe && overrides.qe.length >= 2)
    for (const channel of ['R', 'G', 'B']) {
      const curve = cfa[channel];
      for (let b = 0; b < BAND_COUNT; b++) curve[b] *= qe[b] / (baseQe[b] || 1e-6);
    }
  const laserTotal = integrate(laser, ONES, qe) || 1;
  const ambientTotal = integrate(ambientSpdCurve, ONES, qe) || 1;
  // How much of the ambient spectrum the sensor actually collects, relative to
  // the room's own source. `ambientTint` is peak-normalised, so it carries the
  // ambient colour but not its magnitude; this is the term that dims the
  // ambient-lit board and captures when a drawn spectrum moves power out of the
  // sensor's band. An unedited spectrum yields exactly 1, so a preset's tuned
  // level keeps its meaning and only a hand-drawn curve changes visibility.
  const ambientYield = (integrate(ambientSpdCurve, ONES, qe) || 0) / (integrate(ambientSpd(ambient), ONES, qe) || 1);
  const laserPass = integrate(laser, filter, qe);
  const ambientPass = integrate(ambientSpdCurve, filter, qe);
  const nominal = nominalModel();

  // Contrast: the laser line against the ambient, both at equal radiant power.
  const ambientScaled = ambientTotal ? laserTotal / ambientTotal : 1;
  const before = laserTotal / (ambientTotal * ambientScaled);
  const after = laserPass / (ambientPass * ambientScaled);
  // The ambient's own colour, relative to the reference source, so a tungsten
  // room warms the board and a fluorescent one tints it green.
  const ambientColour = ambientRgb(ambientSpdCurve, cfa);
  const referenceColour = ambientRgb(ambientSpd('led5000'), cfa);
  const tintRaw = ambientColour.map((value, i) => value / (referenceColour[i] || 1));
  const tintPeak = Math.max(...tintRaw) || 1;
  const ambientTint = tintRaw.map(value => value / tintPeak);
  // The angular roll-off is a property of the coating, which the filter sliders
  // still describe; a hand-drawn passband changes the normal-incidence shape and
  // the absolute level, not the coating's angle shift.
  const curve = filterEnabled ? angleCurve(bandCenter, filterFwhm, filterPeak, filterOd, {nEff, sensor, laser}) : Float64Array.from({length: 91}, () => 1);

  const designed = laserRgb(laser, filter, cfa);
  // Re-colour the reference stripe by shifting it toward the designed laser's
  // own spectral colour. An additive shift vanishes at the reference design, so
  // the identity still reproduces the dataset byte for byte, while a 520 nm
  // design now reads as green instead of a blue-tinted mint (a multiplicative
  // ratio kept the reference tint's blue weight).
  const stripe = NOMINAL_STRIPE.map((value, i) => Math.max(0, value + designed[i] - nominal.laserRgb[i]));
  const stripePeak = Math.max(...stripe, 1e-6);

  // The signal the sensor actually collects from the laser line: laser x filter
  // x sensitivity. Normalised so the plot can share one magnitude axis.
  const detected = new Float64Array(BAND_COUNT);
  for (let b = 0; b < BAND_COUNT; b++) detected[b] = laser[b] * filter[b] * qe[b];
  const detectedPeak = Math.max(...detected) || 1;

  return {
    params: {center: bandCenter, fwhm, modes, spacing, filterFwhm, filterPeak, filterOd, filterEnabled, ambient, sensor, nEff, ambientLevel},
    // Only a knot set that actually defines a curve is reported as live.
    controlPoints: {laser: active(overrides.laser), filter: active(overrides.filter),
      ambient: active(overrides.ambient), qe: active(overrides.qe)},
    wavelengths: WAVELENGTHS, laser, filter, ambient: ambientSpdCurve, qe, cfa,
    ambientLevel, ambientYield, ambientRgb: ambientColour, ambientTint,
    detected: Float64Array.from(detected, v => v / detectedPeak),
    laserRgb: designed, nominalRgb: nominal.laserRgb,
    collectedSignal: laserPass,
    laserTransmission: laserPass / laserTotal,
    ambientTransmission: ambientPass / ambientTotal,
    contrastGain: before ? after / before : 1,
    cornerTransmission: curve[curve.length - 1],
    filterCenterAt30: shiftedCwl(bandCenter, 30, nEff),
    angleCurve: curve,
    stripeColor: Array.from(stripe, value => value / stripePeak),
  };
}

/** Radius/angle geometry the per-pixel gain needs, plus the LUT parameters. */
export function transmissionAt(model, degrees) {
  const curve = model.angleCurve, n = curve.length - 1;
  const t = Math.min(1, Math.max(0, degrees) / 45) * n;
  const i0 = t | 0, i1 = Math.min(n, i0 + 1);
  return curve[i0] * (1 - (t - i0)) + curve[i1] * (t - i0);
}

/**
 * Per-pixel parameters for the capture transform.
 *
 * `mode: 'reference'` is the calibration capture: the ambient-lit scene with no
 * bandpass, so its brightness follows the designed ambient level and colour and
 * nothing else. `mode: 'filtered'` is the object scan, which also carries the
 * filter's transmission, the designed stripe colour and the angle roll-off.
 */
export function transformSpec(model, {width, height, cx, cy, focal, maxAngle = 45}, mode = 'filtered') {
  const reference = mode === 'reference';
  return {
    ambient: model.ambientLevel * (model.ambientYield ?? 1) * (reference ? 1 : model.ambientTransmission),
    tint: model.ambientTint,
    laser: reference ? 1 : model.laserTransmission,
    color: model.stripeColor,
    curve: reference ? REFERENCE_CURVE : model.angleCurve,
    maxAngle,
    cx, cy, focal, width, height,
    mode: reference ? 'reference' : 'filtered',
    filterEnabled: model.params.filterEnabled,
    center: model.params.center,
    laserRgb: model.laserRgb,
  };
}

function gainAt(spec, dx, dy) {
  const radius = Math.hypot(dx, dy);
  const degrees = Math.atan2(radius, spec.focal) * 180 / Math.PI;
  const n = spec.curve.length - 1;
  const t = Math.min(1, degrees / spec.maxAngle) * n;
  const i0 = t | 0, i1 = Math.min(n, i0 + 1);
  return spec.curve[i0] * (1 - (t - i0)) + spec.curve[i1] * (t - i0);
}

/**
 * Re-weight a reference capture (the dataset's blue stripe) for the designed
 * illumination. The scalar laser amplitude is the blue excess over the local
 * base; the base is then attenuated by the filter's ambient transmission and
 * the stripe is re-coloured and scaled by the per-pixel angle gain. The
 * identity design reproduces the input byte for byte.
 */
export function applySpectral(pixels, spec) {
  const {width, height, cx, cy} = spec;
  const [sr, sg, sb] = spec.color;
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const s = Math.max(0, b - Math.max(r, g));
      const base = [r - s * NOMINAL_STRIPE[0], g - s * NOMINAL_STRIPE[1], b - s * NOMINAL_STRIPE[2]];
      const k = s * spec.laser * gainAt(spec, x + 0.5 - cx, dy);
      const tint = spec.tint || NEUTRAL;
      // The ambient-lit scene carries the source's level and colour; the laser
      // stripe is self-luminous and does not.
      pixels[i] = clamp(base[0] * spec.ambient * tint[0] + k * sr);
      pixels[i + 1] = clamp(base[1] * spec.ambient * tint[1] + k * sg);
      pixels[i + 2] = clamp(base[2] * spec.ambient * tint[2] + k * sb);
    }
  }
  return pixels;
}

const clamp = value => value < 0 ? 0 : value > 255 ? 255 : value;
const NEUTRAL = [1, 1, 1];
const REFERENCE_CURVE = Float64Array.from({length: 91}, () => 1);

/** Approximate visible colour of a wavelength, for the spectrum legend swatch. */
export function wavelengthColor(nm) {
  const stops = [[380, 90, 0, 160], [420, 70, 0, 255], [450, 0, 60, 255], [490, 0, 200, 255],
    [510, 0, 255, 170], [540, 110, 255, 0], [580, 255, 240, 0], [620, 255, 130, 0],
    [660, 255, 0, 0], [720, 170, 0, 0], [800, 110, 0, 40], [1000, 80, 0, 30]];
  if (nm <= stops[0][0]) return stops[0].slice(1);
  if (nm >= stops[stops.length - 1][0]) return stops[stops.length - 1].slice(1);
  for (let i = 1; i < stops.length; i++) {
    if (nm > stops[i][0]) continue;
    const [x0, ...c0] = stops[i - 1], [x1, ...c1] = stops[i];
    const t = (nm - x0) / (x1 - x0);
    return c0.map((v, k) => v + (c1[k] - v) * t);
  }
  return [255, 255, 255];
}
