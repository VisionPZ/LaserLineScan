// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Mono stride-1 column recovery must be numerically identical to the colour
 * blue-excess path (scatter.js).
 * Ported from the parent repository's tests/laser-scatter-mono.test.mjs.
 */
// Mono (single-channel) recovery must be numerically identical to the colour
// path when the grey intensity equals the colour blue-excess score.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {columnProfile, recoverColumns} from '../../runtime/scatter.js';

const gaussian = (i, centre, sigma) => Math.exp(-0.5 * ((i - centre) / sigma) ** 2);
const CENTRE = x => 8 + 0.4 * x;          // sloping line, rows per column
const SCORE = (x, y) => Math.round(120 * gaussian(y, CENTRE(x), 1.3));

// stride-1 grey: one intensity byte per pixel, score = byte value.
function greyImage(width, height) {
  const grey = new Uint8ClampedArray(width * height);
  for (let x = 5; x < 35; x++) for (let y = 0; y < height; y++) grey[y * width + x] = SCORE(x, y);
  return grey;
}

// stride-4 colour: r = g = 0, so blue-excess = max(0, b - 0) = b.
function colourImage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 5; x < 35; x++) for (let y = 0; y < height; y++) {
    const p = (y * width + x) * 4;
    rgba[p + 2] = SCORE(x, y); rgba[p + 3] = 255;
  }
  return rgba;
}

test('columnProfile reads mono intensity at stride 1', () => {
  const width = 4, grey = new Uint8ClampedArray(12).map((_, i) => i);
  assert.deepEqual(Array.from(columnProfile(grey, width, 1, 1, 3, {stride: 1, mono: true})), [5, 9]);
});

test('mono recovery matches the equivalent colour recovery', () => {
  const width = 40, height = 40;
  const band = {top: new Int32Array(width), bottom: new Int32Array(width).fill(32)};
  const seed = () => new Map([5, 6, 7].map(x => [x, CENTRE(x) + 0.5]));
  const options = {threshold: 40};

  const mono = recoverColumns(greyImage(width, height), width, height, band, [5, 35], seed(), {...options, stride: 1, mono: true});
  const colour = recoverColumns(colourImage(width, height), width, height, band, [5, 35], seed(), options);

  assert.ok(mono.length > 15, `recovered ${mono.length} columns`);
  assert.deepEqual(mono, colour, 'identical x, y and amplitude for both encodings');
  for (const point of mono) assert.ok(Math.abs(point.y - (CENTRE(point.x - .5) + .5)) < 1.0, `row ${point.y} stays on the line`);
});
