// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * The automatic stripe search-ROI derived from the laser-to-camera
 * calibration: depth prior, per-column band, uncertainty and clipping.
 * Ported from the parent repository's tests/laser-stripe-roi.test.mjs.
 */
// Automatic stripe search-ROI, estimated once from laser-to-camera calibration.
//
// The calibration plane maps depth monotonically to image row, so a column's
// stripe can only appear between the rows of the shallowest and deepest
// expected surfaces. determineRoiDepth() turns the depths seen on the reference
// target into that working interval; stripeBand() turns a frame's calibrated
// plane plus the interval into a per-column [top, bottom) search band.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {determineRoiDepth, resolveDepthPrior, declaredDepth, resolveObjectColumns, clipBandColumns, stripeBand, stripeBandUncertainty, bandUncertaintyOptions, bandRows, bandCoverage, framePlane, searchBand} from '../../runtime/stripe-roi.js';
import {undistortPoint, distortPoint} from '../../runtime/board-pose.js';

const PINHOLE = {fx: 1665, fy: 1665, cx: 960, cy: 540, dist: [], model: 'none'};
const BROWN = {fx: 1665, fy: 1665, cx: 960, cy: 540, dist: [-0.18, 0.045, 0.001, -0.0015, -0.008], model: 'brown'};
// Fixed-board renderer plane: Y - 0.7054 Z = -3.0344  ->  z = C/(A xu + yu + B).
const PLANE = [0, -0.7054, -3.03439302];
const rowAt = (x, z, camera = PINHOLE) => camera.cy + camera.fy * (PLANE[2] / z - PLANE[1] - PLANE[0] * ((x + .5 - camera.cx) / camera.fx));

test('the calibration fallback hugs the reference envelope', () => {
  const fixed = [];
  for (let i = 0; i < 2000; i++) fixed.push(3.28 + (i / 1999) * .45);
  const [near, far] = determineRoiDepth(fixed);
  assert.ok(near < 3.28 && far > 3.73, `covers the reference: ${near} .. ${far}`);
  // Only a small frame beyond the envelope, never the old median-relative blow-up.
  assert.ok(near > 3.05 && far < 3.95, `tight: ${near} .. ${far}`);
});

test('a swept reference is covered with a small frame', () => {
  const moving = [];
  for (let i = 0; i < 2000; i++) moving.push(3.09 + (i / 1999) * 1.64);
  const [near, far] = determineRoiDepth(moving);
  assert.ok(near <= 3.09 + 1e-9 && far >= 4.73 - 1e-9, `covers the sweep: ${near} .. ${far}`);
  assert.ok(near < 3.407 && far > 4.657, 'covers the validation objects on its own');
  assert.ok(far - near < 2.4, `does not balloon: ${far - near}`);
});

test('a declared object standoff wins over the calibration fallback', () => {
  const calibration = {stripeRoi: [2.1, 4.9]};
  assert.deepEqual(resolveDepthPrior(calibration, {objectDepth: [3.4, 4.7]}), [3.4, 4.7]);
  assert.deepEqual(resolveDepthPrior(calibration, {}), [2.1, 4.9]);
  assert.deepEqual(resolveDepthPrior(calibration, {objectDepth: [0, 0]}), [2.1, 4.9]);
  assert.equal(resolveDepthPrior({}, {}), null);
});

test('the lab standoffs keep every validation surface inside the band', () => {
  // The coarse objectDepth each rendered validation set declares.
  const priors = [[3.4, 4.7], [3.4, 4.4], [3.9, 4.7], [3.5, 4.3], [3.4, 4.6]];
  for (const depth of priors) {
    const band = stripeBand(PLANE, PINHOLE, 1920, 1080, depth, 8);
    assert.ok(bandCoverage(band, 1080) < .42, `band ${bandCoverage(band, 1080)} for ${depth}`);
    for (const z of [3.407, 4.0, 4.657]) {
      const row = rowAt(0, z);
      if (z >= depth[0] && z <= depth[1]) assert.ok(band.top[0] < row && row < band.bottom[0], `${depth} misses ${z}`);
    }
  }
});

test('resolveObjectColumns projects the object box to a column range', () => {
  const cols = resolveObjectColumns(PINHOLE, {objectBox: [-1, 1, -1, 1, 3, 4]}, 1920, 0);
  // u = cx + fx * x/z; extremes at x/z = -1/3 and +1/3.
  assert.ok(cols[0] >= 404 && cols[0] <= 406, `${cols}`);
  assert.ok(cols[1] >= 1514 && cols[1] <= 1516, `${cols}`);
  assert.equal(resolveObjectColumns(PINHOLE, {}, 1920), null, 'no box means no column bound');
  assert.equal(resolveObjectColumns(PINHOLE, {objectBox: [1, -1, 0, 0, 3, 4]}, 1920), null, 'degenerate box');
});

test('clipBandColumns clears the band outside the object columns', () => {
  const band = {top: Int32Array.from([10, 10, 10, 10, 10]), bottom: Int32Array.from([20, 20, 20, 20, 20])};
  clipBandColumns(band, [1, 4]);
  assert.deepEqual(Array.from(band.top), [0, 10, 10, 10, 0]);
  assert.deepEqual(Array.from(band.bottom), [0, 20, 20, 20, 0]);
  clipBandColumns(band, null);
  assert.deepEqual(Array.from(band.top), [0, 10, 10, 10, 0]);
});

test('too little reference data yields no ROI, never a wrong one', () => {
  assert.equal(determineRoiDepth([]), null);
  assert.equal(determineRoiDepth([3, 3.1, 3.2]), null);
});

test('stripeBand brackets the analytic plane-depth row at every column', () => {
  const band = stripeBand(PLANE, PINHOLE, 1920, 1080, [3.28, 4.73]);
  for (let x = 0; x < 1920; x += 7) {
    const row = rowAt(x, 3.6);
    assert.ok(band.top[x] < row && row < band.bottom[x], `column ${x}: ${band.top[x]} .. ${band.bottom[x]}`);
  }
  assert.ok(bandCoverage(band, 1080) > .4 && bandCoverage(band, 1080) < .8, 'a useful but partial band');
});

test('stripeBand rows grow monotonically with depth', () => {
  const near = stripeBand(PLANE, PINHOLE, 1920, 1080, [3.3, 3.3]);
  const far = stripeBand(PLANE, PINHOLE, 1920, 1080, [4.7, 4.7]);
  for (let x = 0; x < 1920; x += 37) assert.ok(far.top[x] > near.top[x], `column ${x}`);
});

test('the delivered lens is applied to the band edges', () => {
  const band = stripeBand(PLANE, BROWN, 1920, 1080, [3.3, 4.7]);
  for (let x = 0; x < 1920; x += 137) {
    const row = rowAt(x, 3.6, BROWN);
    assert.ok(band.top[x] < row && row < band.bottom[x], `column ${x}: ${band.top[x]} .. ${band.bottom[x]} vs ${row}`);
  }
  // distortPoint and undistortPoint are exact inverses, so a pinhole-placed
  // stripe survives the warp that the band was computed through.
  for (const [u, v] of [[100.5, 200.5], [960.5, 540.5], [1800.5, 900.5]]) {
    const [x, y] = undistortPoint(u, v, BROWN, 'brown'), [u2, v2] = distortPoint(x, y, BROWN, 'brown');
    assert.ok(Math.abs(u2 - u) < 1e-6 && Math.abs(v2 - v) < 1e-6, `${u},${v} -> ${u2},${v2}`);
  }
});

test('framePlane resolves the calibrated plane for each acquisition mode', () => {
  const close = (a, b) => assert.ok(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-12), `${a} vs ${b}`);
  // Stored plane fits carry [A, B, C, rms, inliers, samples]; only the plane
  // terms are returned. This is the shape a moving-board calibration stores.
  const moving = {planeFits: {0: [0, -0.7054, -3.0344, .00112, 12000, 12500]}, fit: [0, 0, 0, .001, 1, 1]};
  close(framePlane(moving, {acquisition: 'moving-board'}, {command: 37, t: .5}), [0, -0.7054, -3.0344]);
  close(framePlane(moving, {acquisition: 'moving-board'}, {command: 0, laserOffset: .1}), [0, -0.7054, -2.9344]);
  // Legacy translating-rig fit is the same plane convention [0, B, C].
  close(framePlane({fit: [.5, .7, 2.7]}, {}, {t: .6}), [0, .5, .7 + 2.7 * .6]);
});

test('the ROI outline can be built for a reviewed calibration frame', () => {
  const calibration = {stripeRoi: [3.28, 4.73], camera: BROWN, planeFits: {0: [0, -0.7054, -3.0344, .00112, 12000, 12500]}, fit: [0, 0, 0, .001, 1, 1]};
  const manifest = {acquisition: 'moving-board', width: 1920, height: 1080};
  const plane = framePlane(calibration, manifest, {command: 42});
  assert.deepEqual(plane.slice(0, 3), [0, -0.7054, -3.0344]);
  const band = stripeBand(plane, calibration.camera, manifest.width, manifest.height, calibration.stripeRoi, 8);
  assert.equal(band.top.length, 1920);
  assert.ok(bandCoverage(band, 1080) < .8, 'a partial band to outline');
});

test('the declared object standoff has one validity test for every reader', () => {
  assert.deepEqual(declaredDepth({objectDepth: [3.4, 4.7]}), [3.4, 4.7]);
  for (const bad of [[0, 0], [4, 3], [0.5], [1, 2, 3], ['a', 'b'], [Infinity, 5], [1, NaN]])
    assert.equal(declaredDepth({objectDepth: bad}), null, `objectDepth ${bad}`);
  assert.equal(declaredDepth({}), null);
  // A standoff the prior rejects must not also silence the band's depth term:
  // the interval falls back to the calibration envelope, so the depth sigma
  // has to come back with it.
  const calibration = {stripeRoi: [3.3, 4.8], boardMetrics: {reprojectionRmse: 1}};
  assert.deepEqual(resolveDepthPrior(calibration, {objectDepth: [0, 0]}), [3.3, 4.8]);
  assert.ok(bandUncertaintyOptions(calibration, {objectDepth: [0, 0]}).depthSigma > 0, 'rejected standoff keeps the depth term');
  assert.equal(bandUncertaintyOptions(calibration, {objectDepth: [3.3, 4.8]}).depthSigma, 0, 'a declared standoff needs no depth term');
  assert.equal(bandUncertaintyOptions(calibration, {}).depthSigma, bandUncertaintyOptions(calibration, {objectDepth: [0, 0]}).depthSigma);
});

test('searchBand is the band the worker, the outline and the coverage share', () => {
  const calibration = {
    stripeRoi: [3.28, 4.73], camera: BROWN,
    planeFits: {0: [0, -0.7054, -3.0344, .00112, 12000, 12500]}, fit: [0, 0, 0, .001, 1, 1],
    boardMetrics: {reprojectionRmse: 2.66},
  };
  const manifest = {acquisition: 'moving-board', width: 1920, height: 1080, objectDepth: [3.4, 4.7], objectBox: [-1, 1, -1, 1, 3.2, 5]};
  const frame = {command: 42};
  const plane = framePlane(calibration, manifest, frame);
  const columns = resolveObjectColumns(calibration.camera, manifest, manifest.width, 8);
  const band = searchBand(calibration, manifest, frame, {}, plane);
  // The default is the verified uncertainty envelope, clipped to the object columns.
  const envelope = stripeBandUncertainty(plane, calibration.camera, manifest.width, manifest.height, [3.4, 4.7], bandUncertaintyOptions(calibration, manifest, {}));
  clipBandColumns(envelope, columns);
  assert.deepEqual(Array.from(band.top), Array.from(envelope.top));
  assert.deepEqual(Array.from(band.bottom), Array.from(envelope.bottom));
  // The fixed-margin band is built only when the mode asks for it.
  const fixed = searchBand(calibration, manifest, frame, {bandMode: 'fixed'}, plane);
  const want = stripeBand(plane, calibration.camera, manifest.width, manifest.height, [3.4, 4.7], 8);
  clipBandColumns(want, columns);
  assert.deepEqual(Array.from(fixed.top), Array.from(want.top));
  assert.deepEqual(Array.from(fixed.bottom), Array.from(want.bottom));
  // The object-column bound is part of the shared band: cleared columns search nothing.
  assert.equal(band.top[0], 0); assert.equal(band.bottom[0], 0);
  assert.ok(bandRows(band, 1080) > 0 && bandRows(band, 1080) < manifest.width * manifest.height);
  // The reported coverage is exactly the rows bandRows() counts.
  assert.equal(bandCoverage(band, 1080), bandRows(band, 1080) / (manifest.width * manifest.height));
  // No calibration, no lens, or no depth interval means no band, never a wrong one.
  assert.equal(searchBand(null, manifest, frame, {}), null);
  assert.equal(searchBand({stripeRoi: [3.3, 4.8]}, manifest, frame, {}), null);
  assert.equal(searchBand({camera: BROWN}, manifest, frame, {}), null);
});

test('the determined band contains the stripe the kernel extracts', async () => {
  const {instance} = await WebAssembly.instantiate(readFileSync(new URL('../../runtime/core.wasm', import.meta.url)), {env: {abort() { throw new Error('abort'); }}});
  const w = instance.exports;
  assert.equal(w.configureImage(1920, 1080), 1);
  const rgba = new Uint8Array(w.memory.buffer, w.inputPtr(), 1920 * 1080 * 4);
  const depth = 3.6;
  for (let y = 0; y < 1080; y++) {
    for (let x = 0; x < 1920; x++) {
      const i = (y * 1920 + x) * 4;
      const blue = Math.round(30 + 150 * Math.exp(-.5 * ((y - rowAt(x, depth)) / 1.2) ** 2));
      rgba[i] = 30; rgba[i + 1] = 30; rgba[i + 2] = blue; rgba[i + 3] = 255;
    }
  }
  const full = w.extract(0, .98, 40, 3, 1);
  const fullStripe = new Float64Array(w.memory.buffer, w.stripePtr(), full * 3).slice();
  const band = stripeBand(PLANE, PINHOLE, 1920, 1080, [depth * .9, depth * 1.1], 8);
  new Int32Array(w.memory.buffer, w.bandTopPtr(), 1920).set(band.top);
  new Int32Array(w.memory.buffer, w.bandBottomPtr(), 1920).set(band.bottom);
  const banded = w.extractBanded(0, .98, 40, 3, 1);
  const bandedStripe = new Float64Array(w.memory.buffer, w.stripePtr(), banded * 3).slice();
  assert.equal(banded, full, 'every column is still detected inside the band');
  for (let k = 0; k < full * 3; k++) assert.equal(bandedStripe[k], fullStripe[k], 'bit-identical stripe');
});
