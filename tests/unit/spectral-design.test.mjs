// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * The spectral design model (spectral.js): preset tables, filter/ambient/sensor
 * maths, the capture transform and the step-0 UI wiring the browser ships.
 * Ported from the parent repository's tests/laser-spectral-ui.test.mjs.
 */
// Spectral design model (runtime/spectral.js). These lock the numbers the
// Python reference produces, so the browser tool, the scan worker and the
// offline renderer agree on what a designed laser + lens filter does.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  spectralModel, applySpectral, transformSpec, angleCurve, transmissionAt,
  laserDiode, bandpass, integrate, sensorQe, LAMBDA_MIN, LAMBDA_MAX,
  AMBIENT_PRESETS, AMBIENT_ORDER, LASER_PRESETS, LASER_ORDER,
  FILTER_PRESETS, FILTER_ORDER, SENSOR_PRESETS, SENSOR_ORDER, wavelengthColor,
  curveFromPoints, controlPointsFor,
} from '../../runtime/spectral.js';
import {buildRigScene} from '../../runtime/rig-scene.js';

const near = (value, target, tol, what) =>
  assert.ok(Math.abs(value - target) <= tol, `${what}: ${value} != ${target} +/-${tol}`);

test('the band is sampled across the silicon response', () => {
  const model = spectralModel();
  assert.equal(model.wavelengths[0], LAMBDA_MIN);
  assert.equal(model.wavelengths[model.wavelengths.length - 1], LAMBDA_MAX);
  assert.equal(model.wavelengths.length, 621);
});

test('a 450/40 filter passes the laser line and rejects the LED ambient', () => {
  const model = spectralModel();
  near(model.laserTransmission, 0.93, 0.01, 'laser transmission');
  near(model.ambientTransmission, 0.101, 0.01, 'ambient transmission');
  near(model.contrastGain, 9.2, 0.5, 'contrast gain');
  // The laser is blue-dominant on the colour sensor too.
  assert.ok(model.laserRgb[2] > model.laserRgb[1] && model.laserRgb[1] > model.laserRgb[0]);
});

test('removing the filter is the identity design', () => {
  const model = spectralModel({filterEnabled: false});
  near(model.laserTransmission, 1, 1e-9, 'laser transmission');
  near(model.ambientTransmission, 1, 1e-9, 'ambient transmission');
  near(model.contrastGain, 1, 1e-9, 'contrast gain');
  near(model.cornerTransmission, 1, 1e-9, 'corner transmission');
  near(model.stripeColor[0], 0.015, 1e-9, 'stripe red');
  near(model.stripeColor[2], 1, 1e-9, 'stripe blue');
});

test('the interference filter blue-shifts and dims the stripe at the frame edge', () => {
  const model = spectralModel();
  near(model.filterCenterAt30, 433.3, 1.5, 'passband at 30 deg');
  const curve = angleCurve(450, 40, 0.93, 5);
  near(curve[0], 1, 1e-9, 'normal incidence');
  // The curve is relative to normal incidence; the absolute transmission at
  // 30 deg is this gain times the 0.93 passband peak (0.711 * 0.93 = 0.661).
  near(curve[60], 0.711, 0.02, 'laser transmission at 30 deg');
  // A 1920x1080 frame at fx 1665 sees about 33.5 deg at its corner.
  near(curve[67], 0.466, 0.02, 'corner transmission');
  assert.ok(curve[curve.length - 1] < 0.02, 'a 45 deg ray loses the line');
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i] <= curve[i - 1] + 1e-9, 'gain is monotonic');
});

test('the stripe colour tracks the designed laser, and the reference is exact', () => {
  const identity = spectralModel({filterEnabled: false});
  near(identity.stripeColor[0], 0.015, 1e-9, 'reference red');
  near(identity.stripeColor[1], 0.12, 1e-9, 'reference green');
  near(identity.stripeColor[2], 1, 1e-9, 'reference blue');
  // The colour the rig plane and the frames use must read as the designed
  // laser: the dominant channel is the one that wavelength excites, and no
  // other channel washes it out with the reference tint's blue.
  const expected = {violet405: 2, blue450: 2, cyan488: 2, green520: 1, green532: 1, red635: 0, red660: 0, nir850: 0};
  for (const [key, channel] of Object.entries(expected)) {
    const preset = LASER_PRESETS[key];
    const stripe = spectralModel({center: preset.center, fwhm: preset.fwhm, modes: preset.modes}).stripeColor;
    assert.equal(stripe.indexOf(Math.max(...stripe)), channel, `${key} stripe ${stripe.map(v => v.toFixed(2))}`);
    stripe.forEach((value, i) => {
      if (i !== channel) assert.ok(value < 0.65, `${key} channel ${i} is ${value.toFixed(2)}`);
    });
  }
});

test('transmissionAt reports the loss at a real field angle', () => {
  const model = spectralModel();
  near(transmissionAt(model, 0), 1, 1e-9, 'on axis');
  near(transmissionAt(model, 33.5), 0.466, 0.02, 'frame corner of a 1920x1080 fx1665 lens');
  near(transmissionAt(model, 30), 0.711, 0.02, '30 deg');
});

test('every ambient preset is physical and differs from the others', () => {
  assert.deepEqual(AMBIENT_ORDER, Object.keys(AMBIENT_PRESETS));
  const seen = new Set();
  for (const key of AMBIENT_ORDER) {
    const model = spectralModel({ambient: key});
    assert.ok(model.ambientTransmission > 0 && model.ambientTransmission < 0.3, `${key} ambient`);
    assert.ok(model.contrastGain > 3, `${key} contrast`);
    assert.ok(model.ambient.length === 621 && model.ambient.some(v => v > 0), `${key} spectrum`);
    seen.add(model.ambientTransmission.toFixed(4));
  }
  assert.equal(seen.size, AMBIENT_ORDER.length, 'ambient presets are distinct');
  // A halogen bulb has almost no power at 450 nm, so it is the easiest to reject.
  assert.ok(spectralModel({ambient: 'halogen'}).contrastGain > spectralModel({ambient: 'daylight'}).contrastGain);
});

test('every laser preset keeps its line inside the filter and its colour', () => {
  assert.deepEqual([...LASER_ORDER].sort(), Object.keys(LASER_PRESETS).sort());
  for (const key of LASER_ORDER) {
    const preset = LASER_PRESETS[key];
    const model = spectralModel({center: preset.center, fwhm: preset.fwhm, modes: preset.modes});
    assert.ok(model.laserTransmission > 0.85, `${key} transmission ${model.laserTransmission}`);
    // The stripe must stay recognisable: bright in the wavelength's own band.
    const nm = preset.center;
    const expected = nm < 500 ? 'b' : nm < 600 ? 'g' : 'r';
    const peak = ['r', 'g', 'b'][model.stripeColor.indexOf(Math.max(...model.stripeColor))];
    assert.equal(peak, expected, `${key} stripe ${model.stripeColor.map(v => v.toFixed(2)).join(',')}`);
  }
  // A 532 nm DPSS laser is far narrower than a multi-mode diode.
  const diode = spectralModel({center: 520, fwhm: 1.5, modes: 3});
  const dpss = spectralModel({center: 532, fwhm: 0.4, modes: 1});
  const width = model => {const v = model.laser; let sum = 0, mean = 0; v.forEach((x, i) => {sum += x; mean += x * model.wavelengths[i];}); mean /= sum; let m2 = 0; v.forEach((x, i) => {m2 += x * (model.wavelengths[i] - mean) ** 2;}); return Math.sqrt(m2 / sum);};
  assert.ok(width(dpss) < width(diode), 'DPSS is narrower');
});

test('every filter preset trades bandwidth against ambient rejection', () => {
  assert.deepEqual([...FILTER_ORDER].sort(), Object.keys(FILTER_PRESETS).sort());
  assert.equal(FILTER_ORDER[0], 'standard40', 'the standard laser-line filter is the default');
  assert.equal(FILTER_ORDER[FILTER_ORDER.length - 1], 'none', 'the filter can be removed');
  const narrow = spectralModel({...FILTER_PRESETS.narrow10, filterFwhm: FILTER_PRESETS.narrow10.fwhm, filterPeak: FILTER_PRESETS.narrow10.tpeak, filterOd: FILTER_PRESETS.narrow10.od});
  const wide = spectralModel({...FILTER_PRESETS.wide80, filterFwhm: FILTER_PRESETS.wide80.fwhm, filterPeak: FILTER_PRESETS.wide80.tpeak, filterOd: FILTER_PRESETS.wide80.od});
  assert.ok(narrow.ambientTransmission < wide.ambientTransmission, 'a 10 nm filter passes less ambient');
  assert.ok(narrow.contrastGain > wide.contrastGain, 'and therefore more contrast');
});

test('every sensor preset changes the collected signal', () => {
  assert.deepEqual([...SENSOR_ORDER].sort(), Object.keys(SENSOR_PRESETS).sort());
  const lines = SENSOR_ORDER.map(key => spectralModel({sensor: key}));
  // The extended-NIR part sees more of the blue-rich ambient than the plain die.
  const plain = spectralModel({sensor: 'imx264'}), nir = spectralModel({sensor: 'imx264llr'});
  assert.ok(nir.contrastGain > plain.contrastGain, 'an extended-NIR sensor rejects more of the blue ambient');
  // A back-illuminated part collects more than a front-illuminated 2/3 in die.
  assert.ok(spectralModel({sensor: 'imx178'}).collectedSignal > plain.collectedSignal, 'higher QE collects more');
  // The polarisation part loses to its own polariser, as does the Bayer mosaic.
  assert.ok(spectralModel({sensor: 'imx250mzr'}).collectedSignal < plain.collectedSignal, 'a polariser costs signal');
  assert.ok(spectralModel({sensor: 'imx264c'}).collectedSignal < plain.collectedSignal, 'a Bayer mosaic costs signal');
  // Every sensor has a physical curve and a documented family.
  for (const key of SENSOR_ORDER) {
    const preset = SENSOR_PRESETS[key];
    assert.ok(preset.source && preset.source.length > 5, `${key} names its family`);
    const model = spectralModel({sensor: key});
    assert.ok(model.qe.length === 621 && model.qe.every(v => v >= 0 && v <= 1), `${key} qe`);
    const peak = Math.max(...model.qe);
    assert.ok(peak > 0.3 && peak <= 1, `${key} peak QE ${peak}`);
    assert.ok(peak > model.qe[0] && peak > model.qe[620], `${key} peaks inside the band`);
  }
  // The set spans a real range of sensitivity rather than one curve relabelled.
  const peaks = lines.map(m => Math.max(...m.qe));
  assert.ok(Math.max(...peaks) - Math.min(...peaks) > 0.25, 'the sensors differ in peak sensitivity');
  const signals = lines.map(m => m.collectedSignal);
  assert.ok(Math.max(...signals) - Math.min(...signals) > 0.3, 'and in collected signal');
  // Every pair differs somewhere in the band, so no two entries are the same part.
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      let difference = 0;
      for (let b = 0; b < 621; b++) difference = Math.max(difference, Math.abs(lines[i].qe[b] - lines[j].qe[b]));
      assert.ok(difference > 0.01, `${SENSOR_ORDER[i]} and ${SENSOR_ORDER[j]} are distinct curves`);
    }
});

test('a hand-drawn curve passes through its knots and stays physical', () => {
  const knots = [{nm: 400, value: 0.1}, {nm: 450, value: 0.9}, {nm: 500, value: 0.2}, {nm: 560, value: 0.2}];
  const curve = curveFromPoints(knots);
  assert.equal(curve.length, 621);
  for (const knot of knots) {
    const index = Math.round(knot.nm - LAMBDA_MIN);
    near(curve[index], knot.value, 1e-9, `knot at ${knot.nm}`);
  }
  // Held flat outside the knots, and never outside the shared magnitude axis.
  assert.equal(curve[0], 0.1, 'held flat before the first knot');
  assert.equal(curve[curve.length - 1], 0.2, 'held flat after the last knot');
  for (const value of curve) assert.ok(value >= 0 && value <= 1, `value ${value}`);
  // Monotone interpolation must not overshoot between two equal knots.
  const flat = curveFromPoints([{nm: 400, value: 0.0}, {nm: 600, value: 1.0}, {nm: 800, value: 1.0}]);
  let overshoot = 0;
  for (let i = 0; i < flat.length; i++) if (flat[i] > 1) overshoot = Math.max(overshoot, flat[i]);
  assert.equal(overshoot, 0, 'no overshoot above the drawn maximum');
  // A single knot is a constant, and no knots is an empty curve.
  assert.ok(curveFromPoints([{nm: 500, value: 0.4}]).every(v => Math.abs(v - 0.4) < 1e-9));
  assert.ok(curveFromPoints([]).every(v => v === 0));
});

test('control points are a compact, faithful stand-in for a curve', () => {
  for (const key of ['laser', 'filter', 'ambient', 'qe']) {
    const model = spectralModel();
    const points = controlPointsFor(model[key]);
    assert.ok(points.length >= 2 && points.length < 60, `${key} knot count ${points.length}`);
    const rebuilt = curveFromPoints(points);
    let worst = 0;
    for (let i = 0; i < rebuilt.length; i++) worst = Math.max(worst, Math.abs(rebuilt[i] - model[key][i]));
    assert.ok(worst < 0.02, `${key} reproduction error ${worst}`);
  }
});

test('hand-drawn control points replace the model curve', () => {
  const base = spectralModel();
  const filter = controlPointsFor(base.filter);
  // Widen the passband by lifting a far knot: the ambient now gets through.
  const widened = filter.map(p => ({...p, value: Math.max(p.value, 0.85)}));
  const edited = spectralModel({}, {filter: widened});
  assert.ok(edited.ambientTransmission > base.ambientTransmission * 3, 'a wide passband passes more ambient');
  assert.ok(edited.contrastGain < base.contrastGain, 'and so the contrast drops');
  assert.ok(edited.filter.some(v => v > 0.8), 'the edited transmission is used');
  assert.equal(edited.controlPoints.filter, widened, 'the model reports the live knots');
  // The other series stay on their model curves.
  const untouched = spectralModel({});
  assert.ok(Math.abs(edited.laserTransmission - untouched.laserTransmission) < 0.05);
  // A response edit changes the collected signal as well.
  const qePoints = controlPointsFor(base.qe).map(p => ({...p, value: p.value * 0.5}));
  assert.ok(spectralModel({}, {qe: qePoints}).collectedSignal < base.collectedSignal * 0.7, 'a weaker response collects less');
  // Removing the knots (fewer than two) returns to the model curve.
  const restored = spectralModel({}, {filter: [{nm: 450, value: 1}]});
  near(restored.ambientTransmission, base.ambientTransmission, 1e-12, 'one knot is not a curve');
  assert.equal(restored.controlPoints.filter, null);
});

test('the ambient source sets the scene level and colour', () => {
  const level = key => spectralModel({ambient: key}).ambientLevel;
  assert.equal(level('led5000'), 1, 'the reference source is level 1');
  assert.ok(level('daylight') > level('led5000'), 'daylight is brighter');
  assert.ok(level('led5000') > level('halogen'), 'a halogen room is dimmer');
  assert.ok(level('halogen') > level('dark'), 'a dark room is much dimmer');
  // The reference source is neutral; tungsten is warm and daylight is cool.
  assert.deepEqual(spectralModel({ambient: 'led5000'}).ambientTint.map(v => +v.toFixed(6)), [1, 1, 1]);
  const warm = spectralModel({ambient: 'halogen'}).ambientTint;
  assert.ok(warm[0] > warm[1] && warm[1] > warm[2], `halogen ${warm.map(v => v.toFixed(2))}`);
  const cool = spectralModel({ambient: 'daylight'}).ambientTint;
  assert.ok(cool[2] > cool[1] && cool[1] > cool[0], `daylight ${cool.map(v => v.toFixed(2))}`);
  // An explicit level overrides whatever the preset carries.
  assert.equal(spectralModel({ambient: 'led5000', ambientLevel: 0.25}).ambientLevel, 0.25);
});

test('the ambient level and colour scale the ambient-lit scene only', () => {
  const geometry = {width: 4, height: 1, cx: 2, cy: 0.5, focal: 1665};
  const surface = (model, mode, rgb = [130, 130, 130, 255]) => {
    const data = Uint8ClampedArray.from([...rgb, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    applySpectral(data, transformSpec(model, geometry, mode));
    return [data[0], data[1], data[2]];
  };
  const neutral = spectralModel({filterEnabled: false});
  const neutralPixel = surface(neutral, 'reference');
  near(neutralPixel[0], 130, 1, 'reference red');
  near(neutralPixel[2], 130, 1, 'reference blue');
  // A dark room dims the board and warms it.
  const darkPixel = surface(spectralModel({filterEnabled: false, ambient: 'dark'}), 'reference');
  assert.ok(darkPixel[2] < 130 * 0.15, `dark blue ${darkPixel[2]}`);
  assert.ok(darkPixel[0] > darkPixel[2], 'and the little light left is warm');
  // A tungsten room warms it without changing the level as much.
  const halogenPixel = surface(spectralModel({filterEnabled: false, ambient: 'halogen'}), 'reference');
  assert.ok(halogenPixel[2] < halogenPixel[0], 'halogen is warm');
  assert.ok(halogenPixel[2] > darkPixel[2], 'but brighter than a dark room');
  // A laser stripe is self-luminous: darkening the room barely touches it.
  const stripe = model => {
    const data = Uint8ClampedArray.from([3, 24, 200, 255, 0, 0, 0, 0]);
    applySpectral(data, transformSpec(model, {width: 2, height: 1, cx: 1, cy: 0.5, focal: 1665}, 'reference'));
    return data[2];
  };
  near(stripe(neutral), 200, 1, 'the stripe in the reference light');
  assert.ok(stripe(spectralModel({filterEnabled: false, ambient: 'dark'})) > 165, 'the stripe survives a dark room');
  // The two capture modes differ in exactly the filter's terms.
  const reference = transformSpec(spectralModel(), geometry, 'reference');
  const filtered = transformSpec(spectralModel(), geometry, 'filtered');
  assert.equal(reference.mode, 'reference');
  assert.equal(reference.laser, 1, 'the reference capture has no filter loss');
  assert.ok(reference.curve.every(v => v === 1), 'and no angle roll-off');
  assert.equal(filtered.mode, 'filtered');
  assert.ok(filtered.ambient < reference.ambient / 5, 'the scan rejects the ambient');
  assert.ok(filtered.laser < 1 && filtered.curve[90] < 0.1, 'and carries the filter and roll-off');
});

test('the rig board follows the ambient source', () => {
  const manifest = {board: {squares: [8, 6], squareLengthMm: 40}, emitterBaselineMm: 248};
  // Sum every vertex colour: only the ambient-lit surfaces vary between designs,
  // while the laser, the field of view and the rulers stay put.
  const brightness = design => {
    const v = buildRigScene(manifest, design).vertices;
    let sum = 0;
    for (let i = 0; i < v.length; i += 10) sum += v[i + 7] + v[i + 8] + v[i + 9];
    return sum;
  };
  const neutral = brightness({ambientLevel: 1, ambientTint: [1, 1, 1]});
  const dark = brightness({ambientLevel: 0.05, ambientTint: [1, 0.85, 0.67]});
  const halogen = brightness({ambientLevel: 0.7, ambientTint: [1, 0.6, 0.27]});
  const bright = brightness({ambientLevel: 1.3, ambientTint: [0.73, 0.85, 1]});
  assert.ok(dark < neutral * 0.5, `a dark room dims the rig (${dark} vs ${neutral})`);
  assert.ok(dark < halogen && halogen < neutral, 'and the order follows the level');
  assert.ok(bright > neutral, 'a bright room lifts it');
  // With no ambient at all the scene survives as a silhouette rather than vanishing.
  assert.ok(brightness({ambientLevel: 0.02, ambientTint: [1, 1, 1]}) > 0);
});

test('the step-0 selects offer exactly the documented presets in order', () => {
  const template = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const options = id => {
    const select = new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`).exec(template);
    assert.ok(select, `${id} is in the page`);
    return [...select[1].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  };
  assert.deepEqual(options('ll-laser-preset'), LASER_ORDER);
  assert.deepEqual(options('ll-filter-preset'), FILTER_ORDER);
  assert.deepEqual(options('ll-sensor-preset'), SENSOR_ORDER);
  assert.deepEqual(options('ll-ambient-preset'), AMBIENT_ORDER);
});

test('the detected curve is laser x filter x sensitivity', () => {
  const model = spectralModel();
  const peak = Math.max(...model.detected);
  near(peak, 1, 1e-9, 'normalised peak');
  const at = nm => {
    const index = Math.round(nm - LAMBDA_MIN);
    return model.detected[index];
  };
  assert.ok(at(450) > at(420) && at(450) > at(480), 'the detected peak sits on the laser line');
});

test('the spectral transform reproduces the reference capture exactly', () => {
  const model = spectralModel({filterEnabled: false});
  const spec = transformSpec(model, {width: 8, height: 4, cx: 4, cy: 2, focal: 1665});
  const pixels = new Uint8ClampedArray(8 * 4 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const stripe = (i / 4) % 5 === 0 ? 180 : 0;
    pixels[i] = 12 + stripe * 0.015;
    pixels[i + 1] = 40 + stripe * 0.12;
    pixels[i + 2] = 60 + stripe;
    pixels[i + 3] = 255;
  }
  const before = Uint8ClampedArray.from(pixels);
  applySpectral(pixels, spec);
  for (let i = 0; i < pixels.length; i += 4)
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(pixels[i + c] - before[i + c]) <= 1,
      `channel ${c} at ${i}: ${pixels[i + c]} vs ${before[i + c]}`);
});

test('the filter darkens the ambient and keeps the stripe', () => {
  const model = spectralModel();
  const spec = transformSpec(model, {width: 4, height: 1, cx: 2, cy: 0.5, focal: 1665});
  const ambient = Uint8ClampedArray.from([120, 130, 140, 255, 120, 130, 140, 255, 120, 130, 140, 255, 120, 130, 140, 255]);
  applySpectral(ambient, spec);
  assert.ok(ambient[2] < 30, `ambient blue was ${ambient[2]}`);
  const stripe = Uint8ClampedArray.from([3, 24, 200, 255, 3, 24, 200, 255, 3, 24, 200, 255, 3, 24, 200, 255]);
  applySpectral(stripe, spec);
  assert.ok(stripe[2] > 150, `stripe blue was ${stripe[2]}`);
});

test('an empty filter is an all-pass transmission', () => {
  const qe = sensorQe();
  const ones = bandpass(450, 40, 1, 0, 4);
  const laser = laserDiode();
  assert.equal(integrate(laser, ones, qe), integrate(laser, laser.map(() => 1), qe));
});

test('wavelengthColor tracks the visible spectrum for the legend swatch', () => {
  const [r, g, b] = wavelengthColor(450);
  assert.ok(b > r && b > g, '450 nm is blue');
  const [r2, g2, b2] = wavelengthColor(532);
  assert.ok(g2 > r2 && g2 > b2, '532 nm is green');
  const [r3, g3, b3] = wavelengthColor(660);
  assert.ok(r3 > g3 && r3 > b3, '660 nm is red');
});

test('the step-1 reference capture ignores the geometry design', () => {
  // Step 0 offers rig designs (baseline, distance) and a geometry enters the
  // spectral transform through the angle roll-off. The calibration capture
  // must stay byte-identical whatever the rig says: only the filtered scan
  // carries the roll-off.
  const pixels = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 5; x++)
      pixels.push(...[20 + x * 30, 15 + y * 25, 30 + x * y * 10, 255]);
  // Blue stripe pixels in the far corners, where a short-focus geometry puts
  // them past the roll-off's maximum angle.
  pixels.splice(16, 4, 3, 24, 200, 255);
  pixels.splice(56, 4, 3, 24, 200, 255);
  const model = spectralModel();
  const reference = geo => {
    const data = Uint8ClampedArray.from(pixels);
    applySpectral(data, transformSpec(model, geo, 'reference'));
    return data;
  };
  const nominal = reference({width: 5, height: 3, cx: 2.5, cy: 1.5, focal: 1665});
  const skewed = reference({width: 5, height: 3, cx: 0, cy: 0, focal: 3});
  assert.deepEqual(skewed, nominal, 'the reference capture is geometry-invariant');
  const filtered = geo => {
    const data = Uint8ClampedArray.from(pixels);
    applySpectral(data, transformSpec(model, geo, 'filtered'));
    return data;
  };
  assert.notDeepEqual(filtered({width: 5, height: 3, cx: 0, cy: 0, focal: 3}), filtered({width: 5, height: 3, cx: 2.5, cy: 1.5, focal: 1665}), 'the filtered capture rolls off with the geometry');
});

test('the default design renders step 1 byte for byte', () => {
  // At blue450 / standard40 / led5000 / level 1 the designed reference capture
  // IS the delivered capture: the re-render a shipped page shows before any
  // design change must be an identity transform of the raw pixels.
  const model = spectralModel();
  const spec = transformSpec(model, {width: 4, height: 2, cx: 2, cy: 1, focal: 1665}, 'reference');
  const pixels = [0, 0, 0, 255, 255, 255, 255, 255, 130, 130, 130, 255, 3, 24, 200, 255,
    40, 90, 60, 255, 250, 10, 120, 255, 200, 200, 220, 255, 1, 250, 2, 255];
  const data = Uint8ClampedArray.from(pixels);
  applySpectral(data, spec);
  assert.deepEqual([...data], pixels, 'the default reference design is the identity');
});

test('every step-0 design consumer agrees on the design it applies', () => {
  // One spectralDesign object drives everything downstream: the GPU preview
  // renders it, the scan job posts it, and every design change re-renders both
  // splits. These locks pin the wiring so a refactor cannot quietly fork it.
  const app = readFileSync(new URL('../../runtime/app.js', import.meta.url), 'utf8');
  assert.ok(/function spectralConfig\(split\)\{[\s\S]*?const spec=transformSpec\(spectralDesign,geometry,split==='validation'\?'filtered':'reference'\)/.test(app),
    'the scan job spectral spec derives from the shared spectralDesign');
  assert.ok(/const mode=split==='validation'&&scanned\.validation\?'filtered':'reference';/.test(app),
    'the preview shows the ambient capture before the scan and the scanner view once it runs');
  assert.ok(app.includes('stopPlay(split);const version=++versions[split];manifests[split]=null;datasets[split]=id;scanned[split]=false;'),
    'selecting a dataset returns the stage to the ambient pre-scan view');
  assert.ok(app.includes('busy=split;scanned[split]=true;state();'),
    'starting the scan switches the stage to the filtered scanner view');
  assert.ok(/if\(split\)\{scanned\[split\]=false;queueSpectralFrame\(split\);\}/.test(app),
    'cancelling the scan returns the stage to the ambient pre-scan view');
  assert.ok(/\$\('v-mode-chip'\);if\(chip\)chip\.textContent=text\(mode==='filtered'\?\(spectralDesign\.params\.filterEnabled\?'filteredChip':'filteredChipOff'\):'ambientChip'\)/.test(app),
    'the view-mode chip announces which capture the stage is showing, and whether a filter is fitted');
  assert.ok(app.includes("spectral:spectralConfig(split)"),
    'config() posts the preview spec to the worker verbatim');
  assert.ok(/active\.postMessage\(\{action:split==='calibration'\?'calibrate':'validate',[\s\S]*?config:config\(split\)/.test(app),
    'both scan jobs run with that config');
  const requeues = app.match(/queueSpectralFrame\('calibration'\);queueSpectralFrame\('validation'\);/g) || [];
  assert.equal(requeues.length, 3,
    'refreshSpectral, the heavy reflow and displayCalibration each re-render both splits');
  assert.ok(/if\(reapply\)\{updateRig\(manifests\.calibration,true\);queueSpectralFrame/.test(app),
    'a design change re-renders the rig and both splits');
  assert.ok(/\}\n\s*\/\/ The measured intrinsics changed the preview geometry[\s\S]*?queueSpectralFrame\('calibration'\);queueSpectralFrame\('validation'\);/.test(app),
    'a finished calibration re-renders the previews with the measured intrinsics');
  assert.ok(app.includes("for(const id of ['rig-baseline','rig-distance'])$(id).addEventListener('input',()=>updateRig(manifests.calibration,true));"),
    'the rig design sliders stay preview-only: they never touch the frames');
  assert.ok(app.includes('emitterBaseline:manifests.calibration?.emitterBaselineMm||248,'),
    'the scan fallback baseline matches the manifest and rig default');
  assert.ok(app.includes('if(canvas.width!==geometry.width)canvas.width=geometry.width;') &&
    app.includes('if(canvas.height!==geometry.height)canvas.height=geometry.height;'),
    'the preview canvas is never reset per frame: a cleared bitmap lets the raw capture flash through while the GPU render is in flight (the per-frame flicker)');
  const worker = readFileSync(new URL('../../runtime/worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes('const {ambient,laser,tint,color,cx,cy,focal,maxAngle,curve}=config.spectral;'),
    'the worker shades with exactly the fields config() posts');
});

test('a hand-drawn laser line moves the coating and the effective stripe', () => {
  const design = (nm) => spectralModel({}, {laser: [{nm: 430, value: 0.02}, {nm, value: 1}]});
  const blue = spectralModel();
  // The passband is chosen for the line it passes, so a drawn 520 nm line moves
  // it off 450 nm exactly as selecting the green preset does: otherwise the
  // design's light never gets through and the stripe keeps reporting the old
  // band's leak (the reported defect).
  const green = design(520);
  assert.equal(green.params.center, 520, 'the coating follows the drawn line');
  assert.equal(green.params.center, spectralModel({center: 520}).params.center, 'drawn line and green preset land on the same band');
  assert.ok(green.stripeColor[1] > 0.9 && green.stripeColor[2] < 0.6,
    `a 520 nm design reads green, not the 450 nm leak: ${green.stripeColor}`);
  const red = design(660);
  assert.equal(red.params.center, 660);
  assert.ok(red.stripeColor[0] > 0.9 && red.stripeColor[1] < 0.5,
    `a 660 nm design reads red: ${red.stripeColor}`);
  // The identity is untouched: no knots, and the reference design, are the same.
  near(blue.params.center, 450, 0, 'the preset band stays put');
  near(blue.stripeColor[2], 1, 0, 'the reference stripe stays NOMINAL_STRIPE blue');
  near(blue.laserTransmission, 0.93, 1e-5, 'the reference transmission is unchanged');
  // A drawn line with no power has no band to place: keep the chosen one.
  near(design(520) && spectralModel({}, {laser: [{nm: 430, value: 0}, {nm: 520, value: 0}]}).params.center, 450, 0,
    'an empty design keeps the selected band');
  // Fewer than two knots is not a curve: the preset diode still defines the line.
  near(spectralModel({}, {laser: [{nm: 520, value: 1}]}).params.center, 450, 0, 'one knot is not a curve');
});

test('a drawn ambient spectrum changes how visible the ambient-lit board is', () => {
  const geometry = {width: 1920, height: 1080, cx: 960, cy: 540, focal: 1665};
  // Unedited, the ambient SPD is the room's own source: yield is exactly 1, so
  // every preset keeps the level it was tuned with (and the identity holds).
  for (const room of ['led5000', 'halogen', 'daylight', 'dark']) {
    const model = spectralModel({ambient: room});
    near(model.ambientYield, 1, 0, `${room} yield`);
    near(transformSpec(model, geometry, 'reference').ambient, model.ambientLevel, 0, `${room} ambient`);
  }
  // A spectrum drawn without the sensor's band leaves the board unlit.
  const unlit = spectralModel({ambient: 'led5000'}, {ambient: [{nm: 430, value: 0}, {nm: 700, value: 0}]});
  near(unlit.ambientYield, 0, 1e-9, 'a spectrum outside the sensor band yields nothing');
  near(transformSpec(unlit, geometry, 'reference').ambient, 0, 1e-9, 'the ambient-lit render goes dark too');
  // A line-only spectrum concentrates the power where the sensor is most
  // sensitive, so the same level lights the board more.
  const line = spectralModel({ambient: 'led5000'}, {ambient: [{nm: 450, value: 1}, {nm: 470, value: 1}]});
  assert.ok(line.ambientYield > 1 && line.ambientYield < 3, `line-only yield ${line.ambientYield}`);
  // The yield is a magnitude term: the chromaticity stays peak-normalised.
  near(Math.max(...line.ambientTint), 1, 1e-12, 'the tint stays peak-normalised');
});

test('the frame windows announce the lens filter and the design drives them', () => {
  const app = readFileSync(new URL('../../runtime/app.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  // Both frame windows carry the hint at their top left, next to the counter.
  for (const id of ['ll-calibration-filter-hint', 'll-validation-filter-hint']) {
    assert.ok(page.includes(`id="${id}"`), `${id} is rendered`);
    assert.ok(page.includes(`class="ll-frame-notices"`), 'the notices share one top-left slot with the counter');
  }
  assert.equal(page.match(/ll-frame-notices/g).length, 2, 'one per frame window');
  // The design's filter decides the hint, and a filter-less scanner view is not
  // advertised as filtered.
  assert.ok(app.includes("for(const id of ['calibration-filter-hint','validation-filter-hint']){const hint=$(id);"),
    'one loop drives both hints');
  assert.ok(app.includes("hint.textContent=text(filterOn?'filterOnHint':'filterOffHint');"),
    'the hint reads the design filter state');
  assert.ok(app.includes("text(mode==='filtered'?(spectralDesign.params.filterEnabled?'filteredChip':'filteredChipOff'):'ambientChip')"),
    'the scanner-view chip follows the fitted filter');
});

// The standalone package ships only the built single-locale index.html, not the
// parent's source locale catalogue (content/laser-copy.json, twelve locales).
// The catalogue assertions are retained verbatim but skipped, because the data
// they lock is not part of the released package.
test('the shipped filter notices carry all twelve locales', {
  skip: 'content/laser-copy.json is not shipped in the standalone package; the built index.html embeds only the active locale',
}, () => {
  const copy = JSON.parse(readFileSync(new URL('../content/laser-copy.json', import.meta.url), 'utf8'));
  for (const key of ['filterOnHint', 'filterOffHint', 'filteredChipOff']) {
    assert.equal(copy[key].length, 12, `${key} carries all twelve locales`);
  }
  assert.equal(copy['filterOnHint'][0], 'Lens filter · on');
  assert.equal(copy['filterOffHint'][0], 'Lens filter · off');
  assert.equal(copy['filteredChipOff'][0], 'No lens filter · scanner view');
});
