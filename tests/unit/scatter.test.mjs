// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Scatter-tail mixture fitting, saturated-shoulder recovery and the
 * missing-column recovery pass (scatter.js).
 * Ported from the parent repository's tests/laser-scatter.test.mjs.
 */
// S1/S2 profile helpers: scatter-tail mixture fit, saturated-shoulder recovery
// and the missing-column recovery pass.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {columnProfile, mixtureCenter, shoulderCenter, recoverColumns} from '../../runtime/scatter.js';

const gaussian = (i, centre, sigma) => Math.exp(-0.5 * ((i - centre) / sigma) ** 2);

test('the mixture fit recovers a narrow surface peak over a curved scatter background', () => {
  const centre = 30.4, profile = new Float64Array(60);
  for (let i = 0; i < 60; i++) profile[i] = 20 + 0.02 * (i - 30) ** 2 + 120 * gaussian(i, centre, 1.2);
  const fit = mixtureCenter(profile, 30);
  assert.ok(fit, 'a fit is returned');
  assert.ok(Math.abs(fit.centre - centre) < 0.2, `centre ${fit.centre}`);
  assert.ok(fit.amplitude > 100, `amplitude ${fit.amplitude}`);
});

test('the mixture fit stays on the surface when the scatter tail is one-sided', () => {
  const centre = 26.3, profile = new Float64Array(60);
  for (let i = 0; i < 60; i++) {
    profile[i] = 8 + 0.01 * (i - 30) ** 2 + 130 * gaussian(i, centre, 1.2);
    if (i > centre) profile[i] += 45 * Math.exp(-(i - centre) / 9);
  }
  const fit = mixtureCenter(profile, 26);
  assert.ok(fit && Math.abs(fit.centre - centre) < 0.6, `centre ${fit && fit.centre}`);
});

test('the shoulder fit recovers a saturated peak centre', () => {
  const centre = 20.3, profile = new Float64Array(40);
  for (let i = 0; i < 40; i++) profile[i] = Math.min(250, 300 * gaussian(i, centre, 1.2));
  const recovered = shoulderCenter(profile, 20, 250);
  assert.ok(recovered !== null && Math.abs(recovered - centre) < 0.4, `centre ${recovered}`);
});

test('columnProfile returns the blue-excess score over the band', () => {
  const width = 4, height = 5, rgba = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, r, g, b) => { const p = (y * width + x) * 4; rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 255; };
  set(1, 2, 10, 20, 90); set(1, 3, 60, 60, 55);
  const profile = columnProfile(rgba, width, 1, 2, 4);
  assert.deepEqual(Array.from(profile), [70, 0], 'row 2 is blue-excess 70, row 3 is not blue');
});

test('recoverColumns fills the columns the kernel did not return', () => {
  const width = 40, height = 40, rgba = new Uint8ClampedArray(width * height * 4).fill(30);
  for (let x = 8; x < 32; x++) for (let y = 0; y < height; y++) {
    const p = (y * width + x) * 4;
    rgba[p + 2] = Math.max(30, Math.round(30 + 120 * gaussian(y, 20.2, 1.3)));
  }
  const band = {top: new Int32Array(width).fill(10), bottom: new Int32Array(width).fill(30)};
  const measured = new Map([[8, 20.7], [9, 20.7], [10, 20.7]]);
  const recovered = recoverColumns(rgba, width, height, band, [8, 32], measured, {threshold: 40});
  assert.ok(recovered.length > 15, `recovered ${recovered.length} columns`);
  for (const point of recovered) {
    assert.ok(!measured.has(Math.floor(point.x - .5)) || point.x - .5 > 10, 'existing columns are skipped');
    assert.ok(Math.abs(point.y - 20.7) < 1.0, `row ${point.y} stays on the line`);
  }
});
