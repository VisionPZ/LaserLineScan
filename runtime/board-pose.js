// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>

/* ChArUco detection, optional marker-corner refinement, camera calibration
 * (intrinsics + lens distortion) and per-view solvePnP run in the browser
 * worker. Pixel coordinates in our manifests use boundary origins (+0.5 vs
 * OpenCV). Distortion models: none, brown (k1,k2,p1,p2,k3), rational
 * (k1,k2,p1,p2,k3,k4,k5,k6) — the ones the vendored OpenCV build can estimate. */
let runtime, detector;
export async function boardRuntime() {
  if (!runtime) runtime = import('./vendor/opencv.js').then(m => new Promise((resolve, reject) => {
    const cv = m.default;
    const ready = () => {
      // This Emscripten build has a legacy then() that resolves to itself.
      // Remove it once initialized so native Promise resolution cannot recurse.
      delete cv.then;
      if (!cv?.aruco_CharucoDetector || !cv.solvePnP) reject(new Error('cornerFailed')); else resolve(cv);
    };
    if (cv.Mat) ready(); else cv.then(ready);
  }));
  return runtime;
}
function buildDetector(cv, manifest, mode) {
  if (detector) return detector;
  const dictionary = cv.getPredefinedDictionary(cv.DICT_5X5_100), ids = new cv.Mat();
  const target = new cv.aruco_CharucoBoard(new cv.Size(...manifest.board.squares), manifest.board.squareLengthMm / manifest.unitMm, manifest.board.markerLengthMm / manifest.unitMm, dictionary, ids);
  const charuco = new cv.aruco_CharucoParameters(), parameters = new cv.aruco_DetectorParameters(), refine = new cv.aruco_RefineParameters(10, 3, true);
  parameters.cornerRefinementMethod = mode === 'subpixel' ? cv.CORNER_REFINE_SUBPIX : cv.CORNER_REFINE_NONE;
  parameters.cornerRefinementWinSize = 5; parameters.cornerRefinementMaxIterations = 40; parameters.cornerRefinementMinAccuracy = .001;
  detector = new cv.aruco_CharucoDetector(target, charuco, parameters, refine);
  ids.delete(); dictionary.delete(); target.delete(); charuco.delete(); parameters.delete(); refine.delete();
  return detector;
}
/** One frame -> detected corner ids plus image (px) and object (board units) points. */
export function detectView(cv, manifest, frame, pixels, mode) {
  const owned = [], mat = (...a) => { const m = cv.matFromArray(...a); owned.push(m); return m; }, empty = () => { const m = new cv.Mat(); owned.push(m); return m; };
  try {
    const { width, height, unitMm, board } = manifest, seed = frame.boardPose;
    buildDetector(cv, manifest, mode);
    const gray = new Uint8Array(width * height); for (let i = 0; i < gray.length; i++) gray[i] = pixels[i * 4];
    const image = mat(height, width, cv.CV_8UC1, gray), refined = empty(), cornerIds = empty(), markerIds = empty(), markerCorners = new cv.MatVector(); owned.push(markerCorners);
    detector.detectBoard(image, refined, cornerIds, markerCorners, markerIds);
    const ids = Array.from(cornerIds.data32S); if (ids.length < 20) throw new Error('cornerFailed');
    const img = Array.from(refined.data32F, v => v + .5), size = board.squareLengthMm / unitMm, columns = board.squares[0] - 1;
    const obj = ids.flatMap(id => [(id % columns + 1) * size, (Math.floor(id / columns) + 1) * size, 0]);
    let totalShift = 0, maxShift = 0;
    for (let i = 0; i < ids.length; i++) {
      const at = seed.ids.indexOf(ids[i]); if (at < 0) continue;
      const shift = Math.hypot(img[i * 2] - seed.corners[at][0], img[i * 2 + 1] - seed.corners[at][1]);
      totalShift += shift; maxShift = Math.max(maxShift, shift);
    }
    return { ids, img, obj, meanShiftPx: totalShift / ids.length, maxShiftPx: maxShift };
  } finally { for (const m of owned) m.delete(); }
}
const DIST_SIZE = { none: 5, brown: 5, rational: 8 };
/** Full camera calibration: intrinsics + the selected lens distortion model. */
export function calibrateViews(cv, manifest, views, model) {
  const owned = [], mat = (...a) => { const m = cv.matFromArray(...a); owned.push(m); return m; };
  try {
    // Intrinsics/distortion need board-pose diversity. The fixed-board rig holds
    // one pose, so its camera is specified (like its known emitter) instead.
    const normals = views.map(v => v.plane).filter(Boolean);
    if (normals.length < 2 || normals.every(n => Math.acos(Math.min(1, Math.abs(n[0] * normals[0][0] + n[1] * normals[0][1] + n[2] * normals[0][2]))) < 0.05)) {
      const size = DIST_SIZE[model] || 5, lens = manifest.lens;
      // The fixed-board rig cannot estimate its own lens, so reuse the known
      // coefficients. Brown and rational share the first five slots
      // (k1,k2,p1,p2,k3), so the known brown lens is also a valid rational
      // lens with k4..k6 = 0.
      const known = lens && lens.model === model ? lens.coefficients.slice(0, size)
        : lens && lens.model === 'brown' && model === 'rational' ? [...lens.coefficients.slice(0, 5), 0, 0, 0]
        : new Array(size).fill(0);
      return { fx: manifest.fx, fy: manifest.fy, cx: manifest.cx, cy: manifest.cy, dist: known, model, rms: null, views: views.length, known: true };
    }
    const objectPoints = new cv.MatVector(), imagePoints = new cv.MatVector(); owned.push(objectPoints, imagePoints);
    for (const v of views) {
      objectPoints.push_back(mat(v.obj.length / 3, 1, cv.CV_32FC3, v.obj));
      imagePoints.push_back(mat(v.img.length / 2, 1, cv.CV_32FC2, v.img));
    }
    const camera = mat(3, 3, cv.CV_64F, [manifest.fx, 0, manifest.cx, 0, manifest.fy, manifest.cy, 0, 0, 1]);
    const size = DIST_SIZE[model] || 5, dist = mat(size, 1, cv.CV_64F, new Array(size).fill(0));
    const rvecs = new cv.MatVector(), tvecs = new cv.MatVector(), sdi = new cv.Mat(), sde = new cv.Mat(), pve = new cv.Mat(); owned.push(rvecs, tvecs, sdi, sde, pve);
    const fix = cv.CALIB_FIX_K1 === undefined ? 0 : cv.CALIB_FIX_K1 | cv.CALIB_FIX_K2 | cv.CALIB_FIX_K3 | cv.CALIB_FIX_P1 | cv.CALIB_FIX_P2;
    // The rational model (k1,k2,p1,p2,k3,k4,k5,k6) is only estimated when
    // OpenCV is told so. Without this flag an 8-element dist is filled with the
    // 5-parameter brown coefficients and the rational reader misreads p1/k3,
    // p2/k4..k6.
    const rational = cv.CALIB_RATIONAL_MODEL ?? 0x4000;
    // The manifest carries the acquisition intrinsics. Seeding the optimiser
    // with them (they are refined, not fixed) converges far faster than
    // OpenCV's default fx=fy=max(width,height) start: ~6 s -> ~0.1 s.
    const guess = cv.CALIB_USE_INTRINSIC_GUESS ?? 0x1;
    const flags = (model === 'none' && size === 5 ? fix : model === 'rational' ? rational : 0) | guess;
    const rms = cv.calibrateCameraExtended(objectPoints, imagePoints, new cv.Size(manifest.width, manifest.height), camera, dist, rvecs, tvecs, sdi, sde, pve, flags);
    const k = camera.data64F, d = Array.from(dist.data64F);
    if (!Number.isFinite(rms) || rms > 5 || !Number.isFinite(k[0]) || k[0] <= 0 || d.length < size) throw new Error('cameraFailed');
    return { fx: k[0], fy: k[4], cx: k[2], cy: k[5], dist: model === 'none' ? new Array(size).fill(0) : d.slice(0, size), model, rms, views: views.length };
  } finally { for (const m of owned) m.delete(); }
}
/** Board pose for one view using the calibrated camera; plane is n·P = d. */
export function poseView(cv, view, camera) {
  const owned = [], mat = (...a) => { const m = cv.matFromArray(...a); owned.push(m); return m; }, empty = () => { const m = new cv.Mat(); owned.push(m); return m; };
  try {
    const object = mat(view.ids.length, 1, cv.CV_64FC3, view.obj), points = mat(view.ids.length, 1, cv.CV_64FC2, view.img);
    const K = mat(3, 3, cv.CV_64F, [camera.fx, 0, camera.cx, 0, camera.fy, camera.cy, 0, 0, 1]);
    const dist = mat(camera.dist.length, 1, cv.CV_64F, camera.dist);
    const rotation = empty(), translation = empty(), matrix = empty(), projected = empty();
    if (!cv.solvePnP(object, points, K, dist, rotation, translation, false, cv.SOLVEPNP_ITERATIVE)) throw new Error('cornerFailed');
    cv.Rodrigues(rotation, matrix); cv.projectPoints(object, rotation, translation, K, dist, projected);
    const r = matrix.data64F, t = translation.data64F, n = [r[2], r[5], r[8]], plane = [...n, n.reduce((sum, v, i) => sum + v * t[i], 0)];
    let squareError = 0;
    for (let i = 0; i < view.ids.length; i++) squareError += (view.img[i * 2] - projected.data64F[i * 2]) ** 2 + (view.img[i * 2 + 1] - projected.data64F[i * 2 + 1]) ** 2;
    if (!plane.every(Number.isFinite) || t[2] <= 0) throw new Error('cornerFailed');
    return { plane, cornerCount: view.ids.length, reprojectionRmse: Math.sqrt(squareError / view.ids.length) };
  } finally { for (const m of owned) m.delete(); }
}
/** Distorted normalized coordinates for an undistorted normalized point.
 * OpenCV orders distortion as (k1,k2,p1,p2,k3[,k4,k5,k6]); the tangent terms
 * are indices 2 and 3 for both models. */
export function distortNormalized(x, y, camera, model) {
  if (model === 'none' || !camera.dist?.length) return [x, y];
  const k = camera.dist;
  const r2 = x * x + y * y;
  const radial = model === 'rational'
    ? (1 + k[0] * r2 + k[1] * r2 ** 2 + k[4] * r2 ** 3) / (1 + k[5] * r2 + k[6] * r2 ** 2 + k[7] * r2 ** 3)
    : 1 + k[0] * r2 + k[1] * r2 ** 2 + (k[4] || 0) * r2 ** 3;
  const p1 = k[2] || 0, p2 = k[3] || 0;
  return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y];
}
/** Forward map: undistorted normalized (x,y) -> delivered pixel (u,v). */
export function distortPoint(x, y, camera, model) {
  const [xd, yd] = distortNormalized(x, y, camera, model);
  return [camera.cx + camera.fx * xd, camera.cy + camera.fy * yd];
}
/** Undistort one pixel to normalized camera coordinates (iterative inverse). */
export function undistortPoint(u, v, camera, model) {
  const xd = (u - camera.cx) / camera.fx, yd = (v - camera.cy) / camera.fy;
  if (model === 'none' || !camera.dist?.length) return [xd, yd];
  let x = xd, y = yd;
  for (let i = 0; i < 20; i++) { const [fx, fy] = distortNormalized(x, y, camera, model), dx = xd - fx, dy = yd - fy; x += dx; y += dy; if (Math.abs(dx) < 1e-11 && Math.abs(dy) < 1e-11) break; }
  return [x, y];
}
