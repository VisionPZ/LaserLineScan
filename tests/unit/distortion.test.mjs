// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Lens-distortion coefficient handling in board-pose.js, including the
 * OpenCV (k1,k2,p1,p2,k3[,k4,k5,k6]) rational-model ordering regression.
 * Ported from the parent repository's tests/laser-distortion.test.mjs.
 */
// Lens-distortion coefficient handling in the laser calibration.
//
// OpenCV orders the distortion vector as (k1,k2,p1,p2,k3[,k4,k5,k6]). The
// rational model therefore shares its first five slots with the brown model,
// and only adds k4..k6. Regression guard for the bug where the rational reader
// treated the vector as (k1..k6,p1,p2), feeding p1 in as k3 — which made a
// rational calibration reconstruct at ~115 mm RMSE instead of ~0.29 mm.
import test from "node:test";
import assert from "node:assert/strict";
import { undistortPoint } from "../../runtime/board-pose.js";

const CAMERA = { fx: 1665, fy: 1665, cx: 960, cy: 540 };
// The simulated lens used by every rendered manifest: k1,k2,p1,p2,k3.
const BROWN = [-0.18, 0.045, 0.001, -0.0015, -0.008];

test("a brown lens is a valid rational lens with k4..k6 = 0", () => {
  const brown = undistortPoint(1280, 760, { ...CAMERA, dist: BROWN }, "brown");
  const rational = undistortPoint(1280, 760, { ...CAMERA, dist: [...BROWN, 0, 0, 0] }, "rational");
  assert.ok(
    Math.abs(rational[0] - brown[0]) < 1e-12 && Math.abs(rational[1] - brown[1]) < 1e-12,
    `rational ${rational} must equal brown ${brown}`,
  );
});

test("the rational denominator reads k4..k6 from indices 5..7", () => {
  const undistorted = [0, 0, 0, 0, 0, 0, 0, 0];
  const withK4 = [0, 0, 0, 0, 0, 0.2, 0, 0];
  const a = undistortPoint(1400, 950, { ...CAMERA, dist: undistorted }, "rational");
  const b = undistortPoint(1400, 950, { ...CAMERA, dist: withK4 }, "rational");
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6, "k4 must affect the denominator");
});

test("the tangential terms are read from indices 2 and 3", () => {
  const withP1 = undistortPoint(1400, 950, { ...CAMERA, dist: [0, 0, 0.01, 0, 0, 0, 0, 0] }, "rational");
  const withStrayP1 = undistortPoint(1400, 950, { ...CAMERA, dist: [0, 0, 0, 0, 0, 0, 0.01, 0] }, "rational");
  assert.ok(Math.hypot(withP1[0] - withStrayP1[0], withP1[1] - withStrayP1[1]) > 1e-6, "p1 is index 2");
});

test("none and a zero rational lens are both identity on the principal axis", () => {
  assert.deepEqual(undistortPoint(960, 540, { ...CAMERA, dist: BROWN }, "none"), [0, 0]);
  const [x, y] = undistortPoint(960, 540, { ...CAMERA, dist: [0, 0, 0, 0, 0, 0, 0, 0] }, "rational");
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12);
});
