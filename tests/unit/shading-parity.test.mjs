// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
/*
 * The browser applySpectral() capture transform must match the kernel shade()
 * byte for byte across the shipped designs.
 * Ported from the parent repository's tests/laser-shading-parity.test.mjs.
 */
// The capture transform exists twice: as applySpectral() in the browser module
// the UI and the node tests use, and as shade() in the WebAssembly kernel the
// scan worker calls because it is the hot loop. They must agree pixel for pixel.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {spectralModel, transformSpec, applySpectral} from '../../runtime/spectral.js';

const KERNEL = new URL('../../runtime/core.wasm', import.meta.url);
const available = existsSync(KERNEL);
const reason = 'run `node scripts/build-laser.mjs` first';

// A frame-sized image with the shapes the transform has to handle: flat grey,
// a blue stripe on a mid grey base, a warm surface, and a saturated patch.
function image(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stripe = Math.abs(y - (height >> 1)) < 2 ? 1 : 0;
      data[i] = 12 + stripe * 0 + (x % 97) * 1.3;
      data[i + 1] = 40 + stripe * 22 + (y % 53) * 0.9;
      data[i + 2] = 60 + stripe * 180 + (x % 31) * 2;
      data[i + 3] = 255;
    }
  return data;
}

function wasmShade(pixels, spec, width, height) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(KERNEL)), {env: {abort() { throw new Error('kernel abort'); }}});
  const wasm = instance.exports;
  wasm.configureImage(width, height);
  new Uint8Array(wasm.memory.buffer, wasm.inputPtr(), pixels.length).set(pixels);
  new Float64Array(wasm.memory.buffer, wasm.shadingCurvePtr(), 91).set(spec.curve);
  wasm.configureShading(spec.ambient, spec.laser, spec.tint[0], spec.tint[1], spec.tint[2],
    spec.color[0], spec.color[1], spec.color[2], spec.cx, spec.cy, spec.focal, spec.maxAngle);
  wasm.shade();
  return new Uint8ClampedArray(new Uint8Array(wasm.memory.buffer, wasm.inputPtr(), pixels.length));
}

test('the kernel transform matches the JavaScript one', {skip: !available && reason}, () => {
  const width = 64, height = 48;
  const geometry = {width, height, cx: width / 2, cy: height / 2, focal: 80};
  const designs = [
    ['filtered default', {}, 'filtered'],
    ['reference default', {}, 'reference'],
    ['green laser', {center: 520, fwhm: 1.5, modes: 3}, 'filtered'],
    ['halogen room', {ambient: 'halogen'}, 'reference'],
    ['dark room', {ambient: 'dark'}, 'reference'],
    ['no filter', {filterEnabled: false}, 'filtered'],
  ];
  for (const [name, params, mode] of designs) {
    const spec = transformSpec(spectralModel(params), geometry, mode);
    const source = image(width, height);
    const expected = applySpectral(Uint8ClampedArray.from(source), spec);
    const actual = wasmShade(source, spec, width, height);
    let worst = 0, at = 0;
    for (let i = 0; i < source.length; i++) {
      if (i % 4 === 3) continue;
      const delta = Math.abs(actual[i] - expected[i]);
      if (delta > worst) { worst = delta; at = i; }
    }
    // Uint8ClampedArray rounds halves to even and the kernel rounds halves up,
    // so a single count of difference is possible; more than that is a bug.
    assert.ok(worst <= 1, `${name}: max channel difference ${worst} at byte ${at} (${actual[at]} vs ${expected[at]})`);
    assert.ok(actual.length === expected.length);
  }
});

test('an unconfigured kernel leaves the image untouched', {skip: !available && reason}, () => {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(KERNEL)), {env: {abort() { throw new Error('kernel abort'); }}});
  const wasm = instance.exports;
  wasm.configureImage(16, 16);
  const source = image(16, 16);
  new Uint8Array(wasm.memory.buffer, wasm.inputPtr(), source.length).set(source);
  wasm.clearShading();
  wasm.shade();
  const after = new Uint8Array(wasm.memory.buffer, wasm.inputPtr(), source.length);
  for (let i = 0; i < source.length; i++) assert.equal(after[i], source[i], `byte ${i}`);
});
