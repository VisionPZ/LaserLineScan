// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Step-0 rig scene geometry: the laser sheet plane, the camera field-of-view
 * frustum and the baseline / standoff rulers (rig-scene.js).
 * Ported from the parent repository's tests/laser-rig.test.mjs.
 */
// Step-0 rig scene: the laser principal axis must lie exactly in the projected
// sheet plane, and the camera field of view must follow the delivered
// intrinsics. `rig-scene.js` is pure geometry, so it runs in Node.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildRigScene} from '../../runtime/rig-scene.js';

const MANIFEST = {
  width: 1920, height: 1080, fx: 1665, fy: 1665, cx: 960, cy: 540,
  emitterBaselineMm: 248, board: {squares: [8, 6], squareLengthMm: 40},
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const vertex = (vertices, index) => [vertices[index], vertices[index + 1], vertices[index + 2]];

test('the laser principal axis lies exactly in the projected sheet plane', () => {
  const scene = buildRigScene(MANIFEST);
  // The sheet keeps its triangle (the first three vertices) plus a rim of three
  // edge quads, so a preset that looks along the plane still sees its edge.
  assert.equal(scene.fan, 21, 'the sheet is one triangle plus a rim of three edge quads');
  assert.ok(scene.sheetThickness > 0 && scene.sheetThickness < 10, `sheet thickness ${scene.sheetThickness} mm`);
  const start = scene.opaque * 10;
  const a = vertex(scene.vertices, start);
  const b = vertex(scene.vertices, start + 10);
  const c = vertex(scene.vertices, start + 20);
  const raw = cross(sub(b, a), sub(c, a)), normal = raw.map((v) => v / len(raw));
  const {origin, direction} = scene.laserAxis;
  assert.ok(Math.abs(dot(normal, direction)) < 1e-6, 'the beam direction is parallel to the sheet');
  assert.ok(Math.abs(dot(normal, sub(a, origin))) < 1e-6 * len(sub(a, origin)), 'the aperture is on the sheet plane');
  assert.ok(Math.abs(dot(normal, sub(origin, a))) < 1e-6 * len(sub(origin, a)), 'the beam origin is on the sheet plane');
  // The rim quads sit half the sheet thickness either side of that plane.
  const rimA = vertex(scene.vertices, start + 30), rimB = vertex(scene.vertices, start + 50); // +o and -o sides of the first rim quad
  const reach = len(sub(a, origin));
  assert.ok(Math.abs(Math.abs(dot(normal, sub(rimA, a))) - scene.sheetThickness / 2) < 1e-6 * reach, 'the rim spans the sheet thickness');
  assert.ok(Math.abs(dot(normal, sub(rimB, a)) + scene.sheetThickness / 2) < 1e-6 * reach, 'the rim is centred on the sheet plane');
  // The aperture is on the principal axis, so the body, the fan and the stripe
  // all share the same central ray.
  const toAperture = sub(a, origin);
  assert.ok(len(cross(toAperture, direction)) < 1e-6 * len(toAperture), 'the aperture is on the principal axis');
});

test('the camera field of view frustum follows the delivered intrinsics', () => {
  const scene = buildRigScene(MANIFEST);
  assert.equal(scene.fov, 18, 'four side triangles from the lens plus a far cap');
  const {apex, axis, halfTan} = scene.cameraFov;
  assert.ok(Math.abs(halfTan[0] - (MANIFEST.width / 2) / MANIFEST.fx) < 1e-12, 'horizontal half-angle from fx');
  assert.ok(Math.abs(halfTan[1] - (MANIFEST.height / 2) / MANIFEST.fy) < 1e-12, 'vertical half-angle from fy');
  const expected = Math.hypot(halfTan[0], halfTan[1]);
  const start = (scene.opaque + scene.fan) * 10;
  let apexVertices = 0;
  for (let i = start; i < start + scene.fov * 10; i += 10) {
    const v = vertex(scene.vertices, i);
    const d = sub(v, apex);
    const along = dot(d, axis);
    assert.ok(along > -1e-2, 'every fov vertex is at or in front of the lens');
    // The side triangles meet at the lens itself, so the volume is attached to
    // the camera rather than floating in front of it. The vertices are stored as
    // float32, so the apex is identified by proximity, not exact equality.
    if (len(d) < 1e-2) { apexVertices++; continue; }
    const perp = len([d[0] - axis[0] * along, d[1] - axis[1] * along, d[2] - axis[2] * along]);
    assert.ok(Math.abs(perp / along - expected) < 1e-6, 'every far corner lies on the frustum edge');
  }
  assert.equal(apexVertices, 4, 'the frustum starts at the lens');
  // The lens the apex sits on is the same point the camera body was built around.
  assert.ok(scene.fovColour && scene.fovColour.length === 3, 'the fov colour is exported');
  const distance = Math.hypot(...scene.fovColour.map((v, k) => v - scene.laserColor[k]));
  assert.ok(distance > 0.3, `the fov colour is distinct from the laser (d=${distance.toFixed(3)})`);
  // The field of view is a semi-transparent light gray.
  assert.ok(scene.fovColour.every(v => v > 0.6), 'the frustum reads as light gray');
  assert.ok(Math.abs(scene.fovColour[0] - scene.fovColour[2]) < 0.12, 'and it is neutral, not tinted');
  assert.ok(Math.abs(scene.angle - Math.atan2(scene.baseline / 2, scene.distance) * 180 / Math.PI) < 1e-9,
    'the head tilt is the symmetric triangulation angle');
  assert.equal(scene.baseline, 248, 'the baseline is the manifest value');
  assert.equal(scene.distance, 388, 'the working distance defaults to the delivered standoff');
});

test('the baseline and the working distance are adjustable and stay consistent', () => {
  for (const [baseline, distance] of [[248, 388], [400, 300], [120, 600], [600, 900], [60, 150]]) {
    const scene = buildRigScene(MANIFEST, {baseline, distance});
    assert.equal(scene.baseline, baseline, 'the baseline is taken from the design');
    assert.equal(scene.distance, distance, 'the distance is taken from the design');
    const dims = Object.fromEntries(scene.dimensions.map((d) => [d.id, d]));
    const span = (d) => Math.hypot(...d.end.map((v, k) => v - d.start[k]));
    assert.ok(Math.abs(span(dims.baseline) - baseline) < 1e-6, 'the baseline ruler matches its endpoints');
    assert.ok(Math.abs(span(dims.object) - distance) < 1e-6, 'the object ruler matches its endpoints');
    assert.ok(Math.abs(dims.object.value - distance) < 1e-6, `object ${dims.object.value} != ${distance}`);
    assert.ok(Math.abs(scene.angle - Math.atan2(baseline / 2, distance) * 180 / Math.PI) < 1e-9, 'the tilt follows the geometry');
    // Whatever the head, the beam still lands on the head axis at the board face,
    // and it stays exactly in the sheet plane.
    const {origin, direction} = scene.laserAxis;
    const travel = distance / direction[2];
    assert.ok(Math.abs(origin[1] + travel * direction[1] + baseline / 2) < 1e-6, 'the beam crosses the head axis on the board');
    const start = scene.opaque * 10;
    const a = vertex(scene.vertices, start);
    const b = vertex(scene.vertices, start + 10);
    const c = vertex(scene.vertices, start + 20);
    const raw = cross(sub(b, a), sub(c, a)), normal = raw.map((v) => v / len(raw));
    assert.ok(Math.abs(dot(normal, direction)) < 1e-6, 'the beam is parallel to the sheet');
    assert.ok(Math.abs(dot(normal, sub(a, origin))) < 1e-6 * len(sub(a, origin)), 'the aperture is on the sheet plane');
  }
  // Extreme values are clamped rather than producing degenerate geometry.
  const tiny = buildRigScene(MANIFEST, {baseline: 1, distance: 1});
  assert.ok(tiny.baseline >= 40 && tiny.distance >= 80, 'the geometry is clamped to a physical head');
});

test('the scene dimensions the baseline and the rig–object distance', () => {
  const scene = buildRigScene(MANIFEST);
  const dims = Object.fromEntries(scene.dimensions.map((d) => [d.id, d]));
  assert.ok(dims.baseline && dims.object, 'both dimensions are emitted');
  const span = (d) => Math.hypot(...d.end.map((v, k) => v - d.start[k]));
  assert.ok(Math.abs(dims.baseline.value - 248) < 1e-9, 'the baseline is the manifest value');
  assert.ok(Math.abs(span(dims.baseline) - dims.baseline.value) < 1e-6, 'the baseline value matches its endpoints');
  assert.ok(Math.abs(span(dims.object) - dims.object.value) < 1e-6, 'the object value matches its endpoints');
  assert.ok(dims.object.value > 300 && dims.object.value < 500, 'the standoff is plausible in mm');
  // The rig reference is the baseline midpoint; the object end is on the board face.
  assert.ok(Math.abs(dims.object.start[1] + dims.baseline.value / 2) < 1e-9, 'the start is the head centre');
  for (const d of scene.dimensions) assert.ok(Array.isArray(d.at) && d.at.every(Number.isFinite), `${d.id} has a label anchor`);
});
