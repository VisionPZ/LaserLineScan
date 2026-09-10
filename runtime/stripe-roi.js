// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>

/* Automatic stripe search-ROI, derived once from laser-to-camera calibration.
 *
 * A calibrated rig fixes the laser sheet and the camera. For a surface at depth
 * z, the sheet meets the ray of column u at normalized height
 *
 *     yu(z,u) = C/z - B - A*xu          (plane: A X + Y + B Z = C)
 *
 * and projects to image row v = cy + fy*yu (before lens distortion). The plane
 * maps depth monotonically to row, so a column's stripe can only appear between
 * the rows of the shallowest and deepest surfaces the scanner is expected to
 * measure. The object standoff is only approximately known, so calibration
 * turns the depths it observed on the reference target into a working interval
 * and expands it by a relative margin; every column then gets one [top, bottom)
 * search band. Validation scores only those rows, for every line-centre
 * estimator, instead of the whole sensor.
 *
 * determineRoiDepth() runs once, inside calibration. stripeBand() is the pure
 * geometry that turns a frame's calibrated plane plus that interval into the
 * per-column band the kernel consumes.
 */
import {distortPoint, undistortPoint} from './board-pose.js';
import {planeAt} from './encoder-model.js';

// The reconstruction range every candidate depth must survive.
const DEPTH_MIN = 1, DEPTH_MAX = 8;

/** Working depth interval [near, far] for the scanned object.
 *
 * The reference target may be fixed or swept through the station. The stripe
 * depths it actually reached define the envelope; the 2nd/98th percentiles trim
 * detection outliers. A small absolute frame is added so a perfectly flat
 * reference still leaves a usable band. This is the fallback when the scan does
 * not declare its own object standoff; the reference envelope is only as close
 * to the object as the reference happened to be. */
export function determineRoiDepth(depths, margin = .2, floor = .15) {
  const values = [];
  for (let i = 0; i < depths.length; i++) {
    const z = depths[i];
    if (Number.isFinite(z) && z > 0) values.push(z);
  }
  if (values.length < 20) return null;
  values.sort((a, b) => a - b);
  const at = q => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
  const lo = at(.02), hi = at(.98);
  const need = Math.max(floor, margin * (hi - lo));
  const near = Math.max(DEPTH_MIN, lo - need);
  const far = Math.min(DEPTH_MAX, hi + need);
  return near < far ? [near, far] : null;
}

/** A declared object standoff `[near, far]`, or null when the manifest does not
 * give a usable one. Every reader of `objectDepth` shares this one validity
 * test, so a manifest can neither widen nor tighten the band through a
 * half-valid interval. */
export function declaredDepth(manifest) {
  const box = manifest?.objectDepth;
  if (!Array.isArray(box) || box.length !== 2) return null;
  const [near, far] = box;
  return Number.isFinite(near) && Number.isFinite(far) && near > 0 && far > near ? [near, far] : null;
}

/** The depth interval the search band is built from: the scan's declared,
 * approximately-known object standoff when it has one, otherwise the interval
 * the calibration estimated from its reference target. */
export function resolveDepthPrior(calibration, manifest) {
  const declared = declaredDepth(manifest);
  if (declared) return declared;
  const roi = calibration?.stripeRoi;
  return Array.isArray(roi) && roi.length === 2 && roi[0] > 0 && roi[1] > roi[0] ? roi : null;
}

/** Per-column search band for one calibrated plane and working depth interval.
 * `margin` is a pixel guard that absorbs the sub-pixel estimator window and
 * any residual distortion of the exact band edges. */
export function stripeBand(plane, camera, width, height, depth, margin = 8) {
  const top = new Int32Array(width), bottom = new Int32Array(width);
  const near = Math.min(depth[0], depth[1]), far = Math.max(depth[0], depth[1]);
  const model = camera.model, distorted = model && model !== 'none' && camera.dist?.length;
  for (let x = 0; x < width; x++) {
    const u = x + .5;
    // The delivered column's undistorted ray direction. Distortion changes the
    // normalized x slightly, so recover it at the principal row and reuse it
    // for both band edges.
    const xu = distorted ? undistortPoint(u, camera.cy, camera, model)[0] : (u - camera.cx) / camera.fx;
    const yuNear = plane[2] / near - plane[1] - plane[0] * xu;
    const yuFar = plane[2] / far - plane[1] - plane[0] * xu;
    let vA, vB;
    if (distorted) {
      vA = distortPoint(xu, yuNear, camera, model)[1];
      vB = distortPoint(xu, yuFar, camera, model)[1];
    } else {
      vA = camera.cy + camera.fy * yuNear;
      vB = camera.cy + camera.fy * yuFar;
    }
    if (!Number.isFinite(vA) || !Number.isFinite(vB)) { top[x] = 0; bottom[x] = height; continue; }
    const lo = Math.min(vA, vB) - margin, hi = Math.max(vA, vB) + margin;
    top[x] = Math.max(0, Math.floor(lo));
    bottom[x] = Math.min(height, Math.ceil(hi));
  }
  return {top, bottom};
}

/** Isotropic plane-coefficient sigma from a stored `[A,B,C,rms,inliers,samples]` fit. */
export function planeCoefficientSigma(fit) {
  if (!Array.isArray(fit) || fit.length < 6) return 0;
  const rms = Number(fit[3]), samples = Number(fit[5]);
  if (!(rms > 0) || !(samples > 0)) return 0;
  return rms / Math.sqrt(samples);
}

/** Per-calibration uncertainty: pixel noise, camera solve (board RMSE), plane fit. */
export function bandUncertaintyOptions(calibration, manifest, config = {}) {
  const reprojection = calibration?.boardMetrics?.reprojectionRmse;
  const declared = !!declaredDepth(manifest);
  const depth = resolveDepthPrior(calibration, manifest);
  return {
    k: config.bandSigmaK ?? 3,
    pixelSigma: config.pixelSigma ?? .5,
    intrinsicSigma: Number.isFinite(reprojection) ? reprojection : (config.intrinsicSigma ?? 0),
    planeSigma: config.planeSigma ?? planeCoefficientSigma(calibration?.fit),
    depthSigma: config.depthSigma ?? (declared ? 0 : Math.max(.02, .05 * (depth ? depth[1] - depth[0] : .3))),
    minMargin: config.bandMinMarginPx ?? 4,
    maxMargin: config.bandMaxMarginPx ?? 160,
  };
}

/** Like stripeBand(), but each edge is widened by k sigma instead of a fixed
 * margin. v(z) = cy + fy*(C/z - B - A*xu); non-finite columns keep the full
 * sensor. Returns {top, bottom, sigma}. */
export function stripeBandUncertainty(plane, camera, width, height, depth, options = {}) {
  const k = options.k ?? 3;
  const pixelSigma = options.pixelSigma ?? .5;
  const intrinsicSigma = options.intrinsicSigma ?? 0;
  const planeSigma = options.planeSigma ?? 0;
  const depthSigma = options.depthSigma ?? 0;
  const minMargin = options.minMargin ?? 4;
  const maxMargin = options.maxMargin ?? 160;
  const near = Math.min(depth[0], depth[1]), far = Math.max(depth[0], depth[1]);
  const top = new Int32Array(width), bottom = new Int32Array(width), sigma = new Float32Array(width);
  const model = camera.model, distorted = model && model !== 'none' && camera.dist?.length;
  const edge = (xu, z) => {
    const yu = plane[2] / z - plane[1] - plane[0] * xu;
    const v = distorted ? distortPoint(xu, yu, camera, model)[1] : camera.cy + camera.fy * yu;
    const dvdz = -camera.fy * plane[2] / (z * z);
    const variance = (dvdz * depthSigma) ** 2
      + (planeSigma * camera.fy) ** 2 * (xu * xu + 1 + 1 / (z * z))
      + intrinsicSigma ** 2 + pixelSigma ** 2;
    return {v, s: Math.sqrt(variance)};
  };
  for (let x = 0; x < width; x++) {
    const u = x + .5;
    const xu = distorted ? undistortPoint(u, camera.cy, camera, model)[0] : (u - camera.cx) / camera.fx;
    const a = edge(xu, near), b = edge(xu, far);
    if (!Number.isFinite(a.v) || !Number.isFinite(b.v)) { top[x] = 0; bottom[x] = height; sigma[x] = Infinity; continue; }
    const s = Math.min(maxMargin / Math.max(k, 1e-6), Math.max(a.s, b.s));
    sigma[x] = s;
    const guard = Math.max(minMargin, k * s);
    top[x] = Math.max(0, Math.floor(Math.min(a.v, b.v) - guard));
    bottom[x] = Math.min(height, Math.ceil(Math.max(a.v, b.v) + guard));
  }
  return {top, bottom, sigma};
}

/** The image columns the approximate object box can project into, as a
 * `[left, right)` range, or null. The box is `[xMin,xMax,yMin,yMax,zMin,zMax]`
 * in camera-model units; the camera-frame shift of a translating rig is vertical
 * only, so the lateral / depth extents (and therefore the columns) are stable. */
export function resolveObjectColumns(camera, manifest, width, margin = 8) {
  const box = manifest?.objectBox;
  if (!Array.isArray(box) || box.length !== 6 || !box.every(Number.isFinite)) return null;
  const [x0, x1, y0, y1, z0, z1] = box;
  if (!(z0 > 0) || !(z1 > z0) || !(x1 > x0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
    const u = distortPoint(x / z, y / z, camera, camera.model)[0];
    if (u < lo) lo = u;
    if (u > hi) hi = u;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const left = Math.max(0, Math.floor(lo - margin));
  const right = Math.min(width, Math.ceil(hi + margin));
  return right - left >= 8 ? [left, right] : null;
}

/** Clear the search band outside a `[left, right)` column range. */
export function clipBandColumns(band, columns) {
  if (!columns) return;
  const [left, right] = columns;
  for (let x = 0; x < band.top.length; x++) {
    if (x < left || x >= right) { band.top[x] = 0; band.bottom[x] = 0; }
  }
}

/** Rows a band leaves to search, as an exact integer. The worker accumulates
 * this per frame and the frame view reports it, so both read one sum. */
export function bandRows(band, height) {
  let rows = 0;
  for (let x = 0; x < band.top.length; x++) {
    rows += Math.max(0, Math.min(height, band.bottom[x]) - Math.max(0, band.top[x]));
  }
  return rows;
}

/** Mean fraction of image rows a band leaves to search, for reporting. */
export function bandCoverage(band, height) {
  return band.top.length ? bandRows(band, height) / (band.top.length * height) : 0;
}

/** The per-column search band a frame is actually scanned with: the frame's
 * calibrated plane, the working depth interval, the configured band mode and
 * the object-column bound. The scan worker and the frame view both build the
 * band here, so the outline drawn in steps 1 and 2 is the band the kernel
 * searched, and the reported coverage is the searched fraction.
 *
 * `plane` may be supplied when the caller already resolved the frame's plane
 * (the worker needs it for the triangulation as well); otherwise it is derived
 * from the calibration, which is also how a manifest without an acquisition
 * model is rejected.
 *
 * The learned row gate is deliberately not part of this band: it needs the
 * decoded pixels of the frame, and it only ever narrows the band, so the
 * outline is a conservative superset of the rows the gate leaves. */
export function searchBand(calibration, manifest, frame, config = {}, plane = undefined) {
  const camera = calibration?.camera;
  if (!camera || !manifest) return null;
  const depth = resolveDepthPrior(calibration, manifest);
  if (!depth) return null;
  const sheet = plane === undefined ? framePlane(calibration, manifest, frame) : plane;
  if (!sheet) return null;
  const margin = config.roiMarginPx ?? 8;
  const width = manifest.width, height = manifest.height;
  const band = config.bandMode === 'fixed'
    ? stripeBand(sheet, camera, width, height, depth, margin)
    : stripeBandUncertainty(sheet, camera, width, height, depth, bandUncertaintyOptions(calibration, manifest, config));
  clipBandColumns(band, resolveObjectColumns(camera, manifest, width, margin));
  return band;
}

/** The calibrated plane `[A, B, C]` a frame is reconstructed with, or null.
 * Fixed-board calibrations carry one fitted plane per command; a moving-board
 * calibration fits the single camera-fixed plane reused by every frame. Stored
 * fits are `[A, B, C, rms, inliers, samples]`, so only the plane terms are kept. */
export function framePlane(calibration, manifest, frame) {
  if (manifest.acquisition) {
    const stored = calibration.encoderModel
      ? planeAt(calibration.encoderModel, frame.commandPosition)
      : (calibration.planeFits?.[frame.command] ?? calibration.planeFits?.[0] ?? []);
    const plane = stored.slice(0, 3);
    if (frame.laserOffset !== undefined) plane[2] += frame.laserOffset;
    return plane.length === 3 ? plane : null;
  }
  return calibration.fit ? [0, calibration.fit[0], calibration.fit[1] + calibration.fit[2] * frame.t] : null;
}
