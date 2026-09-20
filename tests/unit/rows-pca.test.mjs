// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * The trained row-subspace laser gate: loading the shipped rows-pca model,
 * row residuals and the contiguous gate span.
 * Ported from the parent repository's tests/laser-rows-pca.test.mjs.
 */
// Row-level laser gate: the trained row subspace keeps only rows whose
// blue-excess score does not reconstruct from the background basis.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadRowGate, rowResidual, gateSpan} from '../../runtime/rows-pca.js';

// mean = [10, 10], one loading vector = [1, 0], threshold = 5.
const MODEL = () => loadRowGate({dim: 2, k: 1, stride: 1, threshold: 5}, new Float32Array([10, 10, 1, 0]).buffer);

function pixels(rows, width = 2) {
  const data = new Uint8ClampedArray(width * rows.length * 4);
  rows.forEach((row, y) => row.forEach((blue, x) => { data[(y * width + x) * 4 + 2] = blue; }));
  return data;
}

test('the shipped model is the lower-half non-laser object row model', () => {
  const meta = JSON.parse(readFileSync(new URL('../../runtime/rows-pca.json', import.meta.url), 'utf8'));
  const raw = readFileSync(new URL('../../runtime/rows-pca.f32', import.meta.url));
  const blob = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  assert.equal(meta.region, 'lower', 'trained on the laser-free lower half');
  assert.equal(meta.split, 540, 'half-frame split');
  assert.equal(meta.dim, Math.floor((1920 - 1) / meta.stride) + 1, 'sampled columns');
  assert.equal(blob.length, (meta.k + 1) * meta.dim, 'centre plus k loading vectors');
});

test('loadRowGate splits the blob into a mean and loading vectors', () => {
  const gate = MODEL();
  assert.equal(gate.dim, 2);
  assert.equal(gate.k, 1);
  assert.equal(gate.threshold, 5);
  assert.deepEqual(Array.from(gate.mean), [10, 10]);
  assert.deepEqual(Array.from(gate.loadings), [1, 0]);
  assert.throws(() => loadRowGate({dim: 2, k: 1, stride: 1, threshold: 5}, new Float32Array([1]).buffer), /rowGate/);
});

test('rowResidual is zero for rows inside the basis and grows outside it', () => {
  const gate = MODEL(), data = pixels([[10, 10], [10, 20], [20, 10]]);
  assert.equal(rowResidual(gate, data, 2, 0), 0, 'centered row is zero');
  assert.ok(Math.abs(rowResidual(gate, data, 2, 1) - 100) < 1e-9, 'energy along the second axis is orthogonal');
  assert.equal(rowResidual(gate, data, 2, 2), 0, 'energy along the basis is removed');
});

test('gateSpan returns the contiguous rows above the threshold', () => {
  const gate = MODEL(), data = pixels([[10, 10], [10, 20], [10, 25], [10, 10]]);
  assert.deepEqual(gateSpan(gate, data, 2, 0, 4), [1, 2]);
  assert.equal(gateSpan(gate, data, 2, 0, 1), null, 'background-only range selects nothing');
});

test('gateSpan honours the column stride and the row window', () => {
  const gate = loadRowGate({dim: 2, k: 1, stride: 2, threshold: 5}, new Float32Array([10, 10, 1, 0]).buffer);
  // columns 0 and 2 are sampled; the laser sits on the second sample of row 1.
  const data = pixels([[10, 0, 10, 0], [10, 0, 30, 0]], 4);
  assert.equal(rowResidual(gate, data, 4, 0), 0);
  assert.ok(rowResidual(gate, data, 4, 1) > 5);
  assert.deepEqual(gateSpan(gate, data, 4, 0, 2), [1, 1]);
  assert.equal(gateSpan(gate, data, 4, 0, 1), null, 'row 0 alone is background');
});
