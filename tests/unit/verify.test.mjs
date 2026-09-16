// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
/*
 * The E1 out-of-band verification certificate of the laser kernel: per-column
 * exclusion detection, flagged rows and band expansion.
 * Ported from the parent repository's tests/laser-verify.test.mjs.
 */
// E1 — out-of-band verification certificate of the laser kernel. A band that
// excludes an accepted candidate is detected per column (with the offending
// row), and expanding to that row recovers the stripe.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const {instance} = await WebAssembly.instantiate(readFileSync(new URL('../../runtime/core.wasm', import.meta.url)), {env: {abort() { throw new Error('abort'); }}});
const w = instance.exports;
const W = 640, H = 448;
const bandTop = () => new Int32Array(w.memory.buffer, w.bandTopPtr(), 1920);
const bandBottom = () => new Int32Array(w.memory.buffer, w.bandBottomPtr(), 1920);
const excludedMax = () => new Int32Array(w.memory.buffer, w.excludedMaxPtr(), 1920);
const excludedRow = () => new Int32Array(w.memory.buffer, w.excludedRowPtr(), 1920);

function gaussian(centre) {
  const buffer = new Uint8Array(w.memory.buffer, w.inputPtr(), W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    buffer[i] = 30; buffer[i + 1] = 30;
    buffer[i + 2] = Math.round(30 + 150 * Math.exp(-.5 * ((y - centre) / 1.2) ** 2));
    buffer[i + 3] = 255;
  }
  return buffer;
}
function setBand(top, bottom) {
  const t = bandTop(), b = bandBottom();
  for (let x = 0; x < W; x++) { t[x] = top; b[x] = bottom; }
}

test('a band containing the stripe is certified: no excluded candidate', () => {
  w.configureImage(W, H);
  gaussian(300.25);
  setBand(260, 340);
  assert.ok(w.extractBanded(0, .98, 40, 3, .8) > 0, 'stripe found inside the band');
  const threshold = w.thresholdValue();
  assert.equal(w.verifyExcluded(0, 0, W), 0, 'nothing outside the band');
  const max = excludedMax();
  for (let x = 0; x < W; x++) assert.ok(max[x] <= threshold, `column ${x}: ${max[x]} > ${threshold}`);
});

test('a stripe hidden outside the band is flagged with its row', () => {
  w.configureImage(W, H);
  gaussian(300.25);
  setBand(80, 120);
  w.extractBanded(0, .98, 40, 3, .8);
  const flagged = w.verifyExcluded(0, 0, W);
  assert.ok(flagged > 0, 'the out-of-band stripe is detected');
  const max = excludedMax(), row = excludedRow(), threshold = w.thresholdValue();
  assert.ok(max[320] > threshold, `${max[320]} <= ${threshold}`);
  assert.ok(Math.abs(row[320] - 300) <= 2, `argmax row ${row[320]}`);
});

test('expanding to the flagged row recovers the stripe and certifies the band', () => {
  w.configureImage(W, H);
  gaussian(300.25);
  setBand(80, 120);
  const before = w.extractBanded(0, .98, 40, 3, .8);
  assert.equal(before, 0, 'the stripe lies outside the initial band');
  assert.ok(w.verifyExcluded(0, 0, W) > 0);
  const row = excludedRow(), t = bandTop(), b = bandBottom();
  for (let x = 0; x < W; x++) {
    if (row[x] < 0) continue;
    t[x] = Math.min(t[x], row[x] - 6);
    b[x] = Math.max(b[x], row[x] + 7);
  }
  assert.equal(w.verifyExcluded(0, 0, W), 0, 'the expanded band hides nothing');
  const after = w.extractBanded(0, .98, 40, 3, .8);
  assert.ok(after > 500, `recovered columns: ${after}`);
});

test('an empty band excludes the whole column and is flagged', () => {
  w.configureImage(W, H);
  gaussian(300.25);
  setBand(0, 0);
  w.extractBanded(0, .98, 40, 3, .8);
  assert.equal(w.verifyExcluded(0, 0, W), W, 'every column flagged when nothing is searched');
  const row = excludedRow();
  assert.ok(Math.abs(row[400] - 300) <= 2, `argmax row ${row[400]}`);
});

test('verification never changes a certified banded result', () => {
  w.configureImage(W, H);
  gaussian(220.25);
  setBand(180, 260);
  const count = w.extractBanded(0, .98, 40, 3, .8);
  const stripe = new Float64Array(w.memory.buffer, w.stripePtr(), count * 3).slice();
  assert.equal(w.verifyExcluded(0, 0, W), 0);
  const again = w.extractBanded(0, .98, 40, 3, .8);
  const stripeAgain = new Float64Array(w.memory.buffer, w.stripePtr(), again * 3).slice();
  assert.equal(again, count);
  for (let k = 0; k < count * 3; k++) assert.equal(stripeAgain[k], stripe[k]);
});
