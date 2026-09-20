// SPDX-License-Identifier: GPL-3.0-or-later

/** Laser stripe extraction and parallel-plane calibration. All coordinates use
 * pixel centers (u + 0.5, v + 0.5). No validation geometry enters this kernel. */
let WIDTH: i32 = 640;
let HEIGHT: i32 = 448;
// Bytes per pixel: 4 for the colour sensor, 1 for a monochrome one.
let STRIDE: i32 = 4;
const rgba = new StaticArray<u8>(1920 * 1080 * 4);
const stripe = new StaticArray<f64>(1920 * 3);
const histogram = new StaticArray<i32>(256);
// Notebook Hessian buffers: blurA is the separable Gaussian intermediate and is
// reused for the Fsx field once smoothing finishes, blurB holds the smoothed
// blue image fs and sobelY holds Fsy.
const blurA = new StaticArray<f32>(1920 * 1080);
const blurB = new StaticArray<f64>(1920 * 1080);
const sobelY = new StaticArray<f32>(1920 * 1080);
const gauss = new StaticArray<f64>(17);
let gaussReady = false;
const zs = new StaticArray<f64>(240000);
const ys = new StaticArray<f64>(240000);
const ts = new StaticArray<f64>(240000);
const matrix = new StaticArray<f64>(12);
const result = new StaticArray<f64>(8);
// Calibration-derived per-column search band, in delivered pixel rows with an
// exclusive bottom. `extractBanded` searches only these rows; `extract` ignores
// them. configureImage resets every column to the full sensor so an unfilled
// band is a no-op rather than an empty scan.
const bandTop = new StaticArray<i32>(1920);
const bandBottom = new StaticArray<i32>(1920);
// Strongest raw score (and its row) among the rows the band excludes, per column.
const excludedMax = new StaticArray<i32>(1920);
const excludedRow = new StaticArray<i32>(1920);
let lastThreshold: f64 = 0.0;
let samples: i32 = 0;

/** stride 1 addresses a monochrome sensor, where the score is the pixel's own
 * intensity; stride 4 is the colour path, where the score is the blue excess
 * that isolates the laser line from the ambient. The default is applied here
 * rather than as an AssemblyScript default parameter, which would compile the
 * export into a varargs stub gated on `__setArgumentsLength` — a call the plain
 * `configureImage(width, height)` callers cannot make. An omitted argument
 * arrives as 0 and therefore selects the colour default. */
export function configureImage(width: i32, height: i32, stride: i32): i32 {
  if (width < 8 || height < 8 || width > 1920 || height > 1080) return 0;
  if (stride == 0) stride = 4;
  if (stride != 1 && stride != 4) return 0;
  WIDTH = width; HEIGHT = height; STRIDE = stride;
  for (let x = 0; x < 1920; x++) { bandTop[x] = 0; bandBottom[x] = HEIGHT; excludedMax[x] = -1; excludedRow[x] = -1; }
  return 1;
}
export function inputPtr(): usize { return changetype<usize>(rgba); }
export function stripePtr(): usize { return changetype<usize>(stripe); }
export function resultPtr(): usize { return changetype<usize>(result); }
export function bandTopPtr(): usize { return changetype<usize>(bandTop); }
export function bandBottomPtr(): usize { return changetype<usize>(bandBottom); }
export function excludedMaxPtr(): usize { return changetype<usize>(excludedMax); }
export function excludedRowPtr(): usize { return changetype<usize>(excludedRow); }
export function thresholdValue(): f64 { return lastThreshold; }
export function reset(): void { samples = 0; }

function score(i: i32, mode: i32): f64 {
  if (STRIDE == 1) return <f64>unchecked(rgba[i]);
  const b = <f64>rgba[i+2];
  return mode == 1 ? b : Math.max(0, b - Math.max(<f64>rgba[i], <f64>rgba[i+1]));
}

function gaussianKernel(): void {
  if (gaussReady) return;
  // Notebook: `gaussian_filter(blue, sigma=2)`, truncated at 4 sigma.
  const sigma = 2.0, denom = 2.0 * sigma * sigma;
  let sum = 0.0;
  for (let i = -8; i <= 8; i++) { const w = Math.exp(-(<f64>(i * i)) / denom); gauss[i + 8] = w; sum += w; }
  for (let i = 0; i < 17; i++) gauss[i] /= sum;
  gaussReady = true;
}

/** Separable Gaussian (sigma 2, truncate 4) of the colour-excess score image,
 * matching the notebook's `scipy.ndimage.gaussian_filter(blue, 2)` step. */
function smoothScore(mode: i32, hTop: i32, hBot: i32, vTop: i32, vBot: i32, scoreLo: i32, scoreHi: i32, blurLo: i32, blurHi: i32): void {
  gaussianKernel();
  // Score once per pixel into blurB, then blur horizontally into blurA and
  // vertically back into blurB (the vertical pass reads only blurA).
  // The notebook normalises the channel to [0,1] before every derivative, so
  // the Hessian response below stays in its meaningful 0..1 range.
  // hTop..hBot is the horizontal-pass row range (search band + Gaussian reach);
  // vTop..vBot is the vertical-pass row range (search band + Sobel reach).
  // scoreLo..scoreHi is the score/vertical-blur column range and blurLo..blurHi
  // the horizontal-blur range (each expanded by its own reach). Skipping rows or
  // columns outside them is exact: every tap a later pass reads is written.
  for (let y = hTop; y < hBot; y++) {
    const row = y * WIDTH;
    for (let x = scoreLo; x < scoreHi; x++) blurB[row + x] = score((row + x) * STRIDE, mode) / 255.0;
  }
  for (let y = hTop; y < hBot; y++) {
    const row = y * WIDTH;
    for (let x = blurLo; x < blurHi; x++) {
      let acc = 0.0;
      for (let k = -8; k <= 8; k++) {
        let xx = x + k;
        if (xx < 0) xx = 0; else if (xx >= WIDTH) xx = WIDTH - 1;
        acc += unchecked(gauss[k + 8]) * unchecked(blurB[row + xx]);
      }
      blurA[row + x] = <f32>acc;
    }
  }
  for (let y = vTop; y < vBot; y++) {
    for (let x = blurLo; x < blurHi; x++) {
      let acc = 0.0;
      for (let k = -8; k <= 8; k++) {
        let yy = y + k;
        if (yy < 0) yy = 0; else if (yy >= HEIGHT) yy = HEIGHT - 1;
        acc += unchecked(gauss[k + 8]) * <f64>unchecked(blurA[yy * WIDTH + x]);
      }
      blurB[y * WIDTH + x] = acc;
    }
  }
}

/** The notebook's Sobel first derivatives `sobel(fs, 1)` and `sobel(fs, 0)`.
 * After smoothing, blurA is reused for Fsx and sobelY holds Fsy; the kernel is
 * scipy's unnormalised [[-1,0,1],[-2,0,2],[-1,0,1]]. */
function sobelFields(y0: i32, y1: i32, x0: i32, x1: i32): void {
  const start = y0 < 1 ? 1 : y0;
  const end = y1 > HEIGHT - 1 ? HEIGHT - 1 : y1;
  const xa = x0 < 1 ? 1 : x0;
  const xb = x1 > WIDTH - 1 ? WIDTH - 1 : x1;
  for (let y = start; y < end; y++) {
    const row = y * WIDTH;
    for (let x = xa; x < xb; x++) {
      const i = row + x;
      const sx = (blurB[i - WIDTH + 1] + 2.0 * blurB[i + 1] + blurB[i + WIDTH + 1])
               - (blurB[i - WIDTH - 1] + 2.0 * blurB[i - 1] + blurB[i + WIDTH - 1]);
      const sy = (blurB[i + WIDTH - 1] + 2.0 * blurB[i + WIDTH] + blurB[i + WIDTH + 1])
               - (blurB[i - WIDTH - 1] + 2.0 * blurB[i - WIDTH] + blurB[i - WIDTH + 1]);
      blurA[i] = <f32>sx;
      sobelY[i] = <f32>sy;
    }
  }
}

function stripeThreshold(mode: i32, quantile: f64, floor: f64, left: i32, right: i32, y0: i32, y1: i32): f64 {
  for (let i = 0; i < 256; i++) histogram[i] = 0;
  let pixels = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = left; x < right; x += 2) {
      histogram[<i32>score((y * WIDTH + x) * STRIDE, mode)]++;
      pixels++;
    }
  }
  let cumulative = 0;
  let threshold = floor;
  for (let v = 0; v < 256; v++) {
    cumulative += histogram[v];
    if (cumulative >= <i32>(pixels * quantile)) { threshold = Math.max(floor, v); break; }
  }
  return threshold;
}

/** Complete notebook Hessian ridge detector. The sigma-2 Gaussian-smoothed
 * blue image is differentiated with the notebook's chained Sobel operators,
 * Fsxx = sobel_x(Fsx), Fsxy = sobel_x(Fsy), Fsyy = sobel_y(Fsy). The smaller
 * Hessian eigenvalue fpp and its eigenvector ep = [Fsxx-Fsyy-root, 2Fsxy] give
 * the across-ridge normal. Every ridge pixel whose Steger Taylor step
 * t = -grad/H stays inside the cell is a candidate; the notebook's
 *   bright_lines = ((1-e^-fs^2)(1-e^-fpp^2)(1-e^-fsyy^2))^(1/6)
 * is the corresponding ridge/intensity response. The brightest candidate in
 * each column is refined by its Taylor step, giving the sub-pixel stripe. A
 * saturated or flat-topped stripe that has no valid ridge pixel falls back to
 * the same quadratic sub-pixel peak the default estimator uses. */
function extractRidge(mode: i32, floor: f64, threshold: f64, gTop: i32, gBot: i32, banded: bool, xMin: i32, xMax: i32): i32 {
  // The separable Gaussian reaches 8 rows and 8 columns, its chained
  // Sobel/Hessian one more, so compute the fields over the search band plus
  // those halos. Inside the band every value is bit-identical to the full pass.
  const hTop = gTop - 10 < 0 ? 0 : gTop - 10;
  const hBot = gBot + 10 > HEIGHT ? HEIGHT : gBot + 10;
  const vTop = gTop - 2 < 0 ? 0 : gTop - 2;
  const vBot = gBot + 2 > HEIGHT ? HEIGHT : gBot + 2;
  const blurLo = xMin - 2 < 0 ? 0 : xMin - 2;
  const blurHi = xMax + 2 > WIDTH ? WIDTH : xMax + 2;
  const scoreLo = xMin - 10 < 0 ? 0 : xMin - 10;
  const scoreHi = xMax + 10 > WIDTH ? WIDTH : xMax + 10;
  const sobelLo = xMin - 1 < 1 ? 1 : xMin - 1;
  const sobelHi = xMax + 1 > WIDTH - 1 ? WIDTH - 1 : xMax + 1;
  smoothScore(mode, hTop, hBot, vTop, vBot, scoreLo, scoreHi, blurLo, blurHi);
  sobelFields(vTop, vBot, sobelLo, sobelHi);
  let count = 0;
  for (let x = xMin; x < xMax; x++) {
    if (x < 2 || x >= WIDTH - 2) continue;
    let lo = 3, hi = HEIGHT - 3;
    if (banded) { lo = bandTop[x]; if (lo < 3) lo = 3; hi = bandBottom[x]; if (hi > HEIGHT - 3) hi = HEIGHT - 3; if (hi <= lo) continue; }
    let bestRank = -1.0, bestScore = 0.0, bestRow = -1, bestX = 0.0, bestY = 0.0;
    let peakScore = -1.0, peakRow = 0;
    for (let y = lo; y < hi; y++) {
      const value = score((y * WIDTH + x) * STRIDE, mode);
      if (value > peakScore) { peakScore = value; peakRow = y; }
      const i = y * WIDTH + x, fs = blurB[i];
      const fsx = <f64>unchecked(blurA[i]), fsy = <f64>unchecked(sobelY[i]);
      const fsxx = (<f64>unchecked(blurA[i + 1 - WIDTH]) + 2.0 * <f64>unchecked(blurA[i + 1]) + <f64>unchecked(blurA[i + 1 + WIDTH]))
                 - (<f64>unchecked(blurA[i - 1 - WIDTH]) + 2.0 * <f64>unchecked(blurA[i - 1]) + <f64>unchecked(blurA[i - 1 + WIDTH]));
      const fsxy = (<f64>unchecked(sobelY[i + 1 - WIDTH]) + 2.0 * <f64>unchecked(sobelY[i + 1]) + <f64>unchecked(sobelY[i + 1 + WIDTH]))
                 - (<f64>unchecked(sobelY[i - 1 - WIDTH]) + 2.0 * <f64>unchecked(sobelY[i - 1]) + <f64>unchecked(sobelY[i - 1 + WIDTH]));
      const fsyy = (<f64>unchecked(sobelY[i + WIDTH - 1]) + 2.0 * <f64>unchecked(sobelY[i + WIDTH]) + <f64>unchecked(sobelY[i + WIDTH + 1]))
                 - (<f64>unchecked(sobelY[i - WIDTH - 1]) + 2.0 * <f64>unchecked(sobelY[i - WIDTH]) + <f64>unchecked(sobelY[i - WIDTH + 1]));
      const diff = fsxx - fsyy;
      const root = Math.sqrt(diff * diff + 4.0 * fsxy * fsxy);
      const fpp = (fsxx + fsyy - root) * 0.5;
      if (fpp >= 0) continue;   // bright ridge only: curvature across it is negative
      // ep = [diff - root, 2 fsxy] collapses on an exactly axis-aligned ridge;
      // there the normal is perpendicular to eq = [diff + root, 2 fsxy].
      let nx = diff - root, ny = 2.0 * fsxy;
      let nl = Math.sqrt(nx * nx + ny * ny);
      if (nl < 1e-6) { const ex = diff + root, ey = 2.0 * fsxy; nx = -ey; ny = ex; nl = Math.sqrt(nx * nx + ny * ny); }
      if (nl < 1e-6) continue;
      nx /= nl; ny /= nl;
      const den = nx * nx * fsxx + 2.0 * nx * ny * fsxy + ny * ny * fsyy;
      if (Math.abs(den) < 1e-12) continue;
      // The chained Sobel gradient estimates 8*grad and the chained Hessian
      // estimates 64*H (kernel first/second moments), so the raw Taylor step is
      // t/8. Multiplying by 8 restores Steger's t = -grad/H.
      const scalar = -8.0 * (nx * fsx + ny * fsy) / den;
      let sx = scalar * nx, sy = scalar * ny;
      // The Taylor estimate can land a few hundredths past the pixel centre
      // when the ridge sits almost exactly on the boundary; clamp into the cell.
      if (Math.abs(sx) > 0.6 || Math.abs(sy) > 0.6) continue;
      sx = Math.max(-0.5, Math.min(0.5, sx));
      sy = Math.max(-0.5, Math.min(0.5, sy));
      // Gate every ridge candidate on the same raw intensity and contrast test
      // the other estimators use, then rank by the notebook's bright_lines
      // response weighted by intensity: the response saturates on stripe pixels
      // and cannot order them on its own.
      const candidateScore = value;
      if (candidateScore <= threshold) continue;
      const candidateBackground = (score(((y - 3) * WIDTH + x) * STRIDE, mode) + score(((y + 3) * WIDTH + x) * STRIDE, mode)) * 0.5;
      if (candidateScore - candidateBackground < floor * .35) continue;
      const response = (1.0 - Math.exp(-fs * fs)) * (1.0 - Math.exp(-fpp * fpp)) * (1.0 - Math.exp(-fsyy * fsyy));
      const rank = response * candidateScore;
      if (rank > bestRank) {
        bestRank = rank; bestScore = candidateScore; bestRow = y; bestX = sx; bestY = sy;
      }
    }
    // No Hessian ridge pixel in this column: keep the column with the default
    // quadratic sub-pixel peak (saturated or flat-topped stripe).
    if (bestRow < 0) {
      if (peakRow < 3 || peakScore <= threshold) continue;
      const a = score(((peakRow - 1) * WIDTH + x) * STRIDE, mode);
      const c = score(((peakRow + 1) * WIDTH + x) * STRIDE, mode);
      const curvature = a - 2.0 * peakScore + c;
      const background = (score(((peakRow - 3) * WIDTH + x) * STRIDE, mode) + score(((peakRow + 3) * WIDTH + x) * STRIDE, mode)) * 0.5;
      if (peakScore - background < floor * .35) continue;
      let delta = 0.0;
      if (curvature < -.01) delta = Math.max(-.5, Math.min(.5, .5 * (a - c) / curvature));
      stripe[count*3] = x + .5;
      stripe[count*3+1] = peakRow + .5 + delta;
      stripe[count*3+2] = peakScore;
      count++;
      continue;
    }
    stripe[count*3] = x + bestX + .5;
    stripe[count*3+1] = bestRow + bestY + .5;
    stripe[count*3+2] = bestScore;
    count++;
  }
  return count;
}

/** mode 0 = blue colour excess, 1 = blue channel. estimator 0 = quadratic
 * ridge peak, 1 = local intensity centroid, 2 = integer peak, 3 = complete
 * notebook Hessian ridge (sub-pixel, sigma-2 Gaussian + chained Sobel).
 * banded searches only the calibration-derived per-column rows; extractImpl
 * otherwise scans the full sensor. The band is applied to every estimator. */
function extractImpl(mode: i32, quantile: f64, floor: f64, estimator: i32, roi: f64, banded: bool): i32 {
  const left = <i32>(WIDTH * (1 - roi) / 2);
  const right = WIDTH - left;
  // Full-sensor threshold: the band limits where a peak is found, never whether
  // it is accepted. Computed before the band union so verifyExcluded() is fresh.
  const threshold = stripeThreshold(mode, quantile, floor, left, right, 0, HEIGHT);
  lastThreshold = threshold;
  // Row and column range the ridge fields must cover: the union of the
  // per-column bands over the scanned columns. Columns with an empty band are
  // skipped, and if every column is empty there is nothing to score.
  let gTop = 3, gBot = HEIGHT - 3, xMin = left, xMax = right;
  if (banded) {
    let lo = HEIGHT, hi = 0, xa = right, xb = left;
    for (let x = left; x < right; x++) {
      let t = bandTop[x]; if (t < 3) t = 3;
      let b = bandBottom[x]; if (b > HEIGHT - 3) b = HEIGHT - 3;
      if (b <= t) continue;
      if (t < lo) lo = t;
      if (b > hi) hi = b;
      if (x < xa) xa = x;
      if (x >= xb) xb = x + 1;
    }
    if (hi <= lo) return 0;
    gTop = lo; gBot = hi;
    xMin = xa < 2 ? 2 : xa;
    xMax = xb > WIDTH - 2 ? WIDTH - 2 : xb;
  }
  if (estimator == 3) return extractRidge(mode, floor, threshold, gTop, gBot, banded, xMin, xMax);
  let count = 0;
  for (let x = xMin; x < xMax; x++) {
    let lo = 3, hi = HEIGHT - 3;
    if (banded) { lo = bandTop[x]; if (lo < 3) lo = 3; hi = bandBottom[x]; if (hi > HEIGHT - 3) hi = HEIGHT - 3; if (hi <= lo) continue; }
    let peak = -1.0;
    let row = 0;
    for (let y = lo; y < hi; y++) {
      const value = score((y * WIDTH + x) * STRIDE, mode);
      if (value > peak) { peak = value; row = y; }
    }
    if (peak <= threshold || row < 3 || row >= HEIGHT - 3) continue;
    // Reject broad highlights. The laser profile should be a localized ridge.
    const background = (score(((row-3) * WIDTH + x) * STRIDE, mode) + score(((row+3) * WIDTH + x) * STRIDE, mode)) * 0.5;
    if (peak - background < floor * .35) continue;
    let delta = 0.0;
    if (estimator == 0) {
      const a = score(((row-1) * WIDTH + x) * STRIDE, mode), b = peak, c = score(((row+1) * WIDTH + x) * STRIDE, mode);
      const curvature = a - 2*b + c;
      if (curvature < -.01) delta = Math.max(-.5, Math.min(.5, .5*(a-c)/curvature));
    } else if (estimator == 1) {
      let weighted = 0.0, total = 0.0;
      for (let k = -2; k <= 2; k++) {
        const weight = Math.max(0, score(((row+k) * WIDTH + x) * STRIDE, mode) - background);
        weighted += k * weight; total += weight;
      }
      if (total > 0) delta = weighted / total;
    }
    stripe[count*3] = x + .5;
    stripe[count*3+1] = row + .5 + delta;
    stripe[count*3+2] = peak;
    count++;
  }
  return count;
}

/** Full-sensor stripe extraction. */
export function extract(mode: i32, quantile: f64, floor: f64, estimator: i32, roi: f64): i32 {
  return extractImpl(mode, quantile, floor, estimator, roi, false);
}

/** Calibration-constrained stripe extraction. The caller fills bandTopPtr/
 * bandBottomPtr with one [top, bottom) row interval per image column; only
 * those rows are scored, thresholded and tracked. */
export function extractBanded(mode: i32, quantile: f64, floor: f64, estimator: i32, roi: f64): i32 {
  return extractImpl(mode, quantile, floor, estimator, roi, true);
}

/** Strongest excluded score per column in [left, right), with its row. An
 * accepted centre needs score > thresholdValue(), so a column at or below the
 * threshold cannot hide one. Returns how many columns exceed it. */
export function verifyExcluded(mode: i32, left: i32, right: i32): i32 {
  const threshold = lastThreshold;
  let flagged = 0;
  for (let x = left; x < right; x++) {
    let lo = bandTop[x]; if (lo < 3) lo = 3;
    let hi = bandBottom[x]; if (hi > HEIGHT - 3) hi = HEIGHT - 3;
    let best = -1, bestRow = -1;
    if (hi <= lo) {
      for (let y = 3; y < HEIGHT - 3; y++) {
        const s = <i32>score((y * WIDTH + x) * STRIDE, mode);
        if (s > best) { best = s; bestRow = y; }
      }
    } else {
      for (let y = 3; y < lo; y++) {
        const s = <i32>score((y * WIDTH + x) * STRIDE, mode);
        if (s > best) { best = s; bestRow = y; }
      }
      for (let y = hi; y < HEIGHT - 3; y++) {
        const s = <i32>score((y * WIDTH + x) * STRIDE, mode);
        if (s > best) { best = s; bestRow = y; }
      }
    }
    excludedMax[x] = best; excludedRow[x] = bestRow;
    if (<f64>best > threshold) flagged++;
  }
  return flagged;
}

export function addReference(z: f64, y: f64, t: f64): void {
  if (samples >= 240000 || !isFinite(z) || !isFinite(y) || !isFinite(t) || z <= 0) return;
  zs[samples] = z; ys[samples] = y; ts[samples] = t; samples++;
}

function solve(fixed: bool, tilt: f64): bool {
  const n = fixed ? 2 : 3;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let k = i+1; k < n; k++) if (Math.abs(matrix[k*4+i]) > Math.abs(matrix[pivot*4+i])) pivot = k;
    if (Math.abs(matrix[pivot*4+i]) < 1e-10) return false;
    for (let j = 0; j < 4; j++) { const a = matrix[i*4+j]; matrix[i*4+j] = matrix[pivot*4+j]; matrix[pivot*4+j] = a; }
    const scale = matrix[i*4+i];
    for (let j = i; j < 4; j++) matrix[i*4+j] /= scale;
    for (let k = 0; k < n; k++) {
      if (k == i) continue;
      const weight = matrix[k*4+i];
      for (let j = i; j < 4; j++) matrix[k*4+j] -= weight * matrix[i*4+j];
    }
  }
  if (fixed) { result[0]=tilt; result[1]=matrix[3]; result[2]=matrix[7]; }
  else { result[0]=matrix[3]; result[1]=matrix[7]; result[2]=matrix[11]; }
  return true;
}

/** Robust IRLS estimates Y + a Z = b + c t from known reference points.
 * fixedTilt selects a user-constrained model; otherwise a, b and c are fit. */
export function fit(cutoff: f64, fixedTilt: bool, tilt: f64): i32 {
  if (samples < 100 || cutoff <= 0) return 0;
  for (let iteration = 0; iteration < 6; iteration++) {
    for (let i = 0; i < 12; i++) matrix[i] = 0;
    const n = fixedTilt ? 2 : 3;
    for (let i = 0; i < samples; i++) {
      const residual = ys[i] + result[0]*zs[i] - result[1] - result[2]*ts[i];
      const weight = iteration == 0 ? 1 : Math.min(1, cutoff / Math.max(1e-10, Math.abs(residual)));
      const a0 = fixedTilt ? 1 : zs[i];
      const a1 = fixedTilt ? ts[i] : -1;
      const a2 = -ts[i];
      const b = fixedTilt ? ys[i] + tilt*zs[i] : -ys[i];
      for (let row = 0; row < n; row++) {
        const ar = row == 0 ? a0 : row == 1 ? a1 : a2;
        for (let col = 0; col < n; col++) {
          const ac = col == 0 ? a0 : col == 1 ? a1 : a2;
          matrix[row*4+col] += weight*ar*ac;
        }
        matrix[row*4+3] += weight*ar*b;
      }
    }
    if (!solve(fixedTilt, tilt)) return 0;
  }
  let error = 0.0;
  let inliers = 0;
  for (let i = 0; i < samples; i++) {
    const r = ys[i] + result[0]*zs[i] - result[1] - result[2]*ts[i];
    if (Math.abs(r) <= cutoff*3) { error += r*r; inliers++; }
  }
  result[3] = Math.sqrt(error / Math.max(1, inliers));
  result[4] = inliers; result[5] = samples;
  return inliers > 100 && isFinite(result[0]) && result[2] > 0 ? 1 : 0;
}

/** Ray / laser-plane intersection. No mesh or ground-truth depth is accessed. */
export function depth(v: f64, t: f64, fy: f64, cy: f64): f64 {
  const denom = (v - cy) / fy + result[0];
  if (Math.abs(denom) < 1e-7) return -1;
  const z = (result[1] + result[2] * t) / denom;
  return z > 0 && isFinite(z) ? z : -1;
}

// ChArUco modes use a general plane Y + nx X + nz Z = d. The X samples
// reuse ts after reset; these fits are separate from the translating rig.
export function addPlanePoint(x: f64, y: f64, z: f64): void {
  if(samples>=240000 || !isFinite(x) || !isFinite(y) || !isFinite(z) || z<=0)return;
  ts[samples]=x;ys[samples]=y;zs[samples]=z;samples++;
}

export function fitPlane(cutoff: f64, knownEmitter: bool, ex: f64, ey: f64, ez: f64): i32 {
  if(samples<60||cutoff<=0)return 0;
  for(let iteration=0;iteration<6;iteration++){
    for(let k=0;k<12;k++)matrix[k]=0;
    const n=knownEmitter?2:3;
    for(let i=0;i<samples;i++){
      const residual=ys[i]+result[0]*ts[i]+result[1]*zs[i]-result[2];
      const weight=iteration==0?1:Math.min(1,cutoff/Math.max(1e-10,Math.abs(residual)));
      const a0=ts[i]-(knownEmitter?ex:0),a1=zs[i]-(knownEmitter?ez:0),a2=-1.0;
      const b=-ys[i]+(knownEmitter?ey:0);
      for(let row=0;row<n;row++){
        const ar=row==0?a0:row==1?a1:a2;
        for(let col=0;col<n;col++)matrix[row*4+col]+=weight*ar*(col==0?a0:col==1?a1:a2);
        matrix[row*4+3]+=weight*ar*b;
      }
    }
    if(!solve(knownEmitter,0))return 0;
    if(knownEmitter){result[0]=matrix[3];result[1]=matrix[7];result[2]=ey+result[0]*ex+result[1]*ez;}
  }
  let inliers=0;let error=0.0;
  const norm=Math.sqrt(1+result[0]*result[0]+result[1]*result[1]);
  for(let i=0;i<samples;i++){
    const r=(ys[i]+result[0]*ts[i]+result[1]*zs[i]-result[2])/norm;
    if(Math.abs(r)<cutoff*3){error+=r*r;inliers++;}
  }
  result[3]=Math.sqrt(error/Math.max(1,inliers));result[4]=inliers;result[5]=samples;
  return inliers>=60&&isFinite(result[0])&&isFinite(result[1])&&isFinite(result[2])?1:0;
}

export function generalDepth(u: f64,v: f64,focal: f64,cx: f64,cy: f64,nx: f64,nz: f64,d: f64): f64 {
  const denom=nx*(u-cx)/focal+(v-cy)/focal+nz;
  if(Math.abs(denom)<1e-7)return -1;
  const z=d/denom;return z>0&&isFinite(z)?z:-1;
}

/* ---------------------------------------------------------------- shading */
/*
 * Per-pixel capture transform, mirroring applySpectral() in
 * public/laser/spectral.js: the ambient-lit base is scaled by the ambient gain
 * and tint, while the laser stripe is re-coloured and scaled by the per-pixel
 * angle gain. It lives here because that 2 MPixel loop is by far the largest
 * cost of a scan — measured at 79 ms per frame in JavaScript against 3.7 ms for
 * the whole extraction kernel.
 */
const shadingCurve = new StaticArray<f64>(91);
// The angle gain depends only on the radius, and the geometry does not change
// during a job, so the field is built once in configureShading instead of
// running an atan2 per pixel per frame.
const gainField = new StaticArray<f32>(1920 * 1080);
let shadeAmbient: f64 = 1.0;
let shadeLaser: f64 = 1.0;
let shadeTintR: f64 = 1.0, shadeTintG: f64 = 1.0, shadeTintB: f64 = 1.0;
let shadeStripeR: f64 = 0.015, shadeStripeG: f64 = 0.12, shadeStripeB: f64 = 1.0;
let shadeCx: f64 = 0.0, shadeCy: f64 = 0.0, shadeFocal: f64 = 1.0, shadeMaxAngle: f64 = 45.0;
let shadeReady: bool = false;

/** The 91-sample angle-gain curve, written by the host before `shade()`. */
export function shadingCurvePtr(): usize { return changetype<usize>(shadingCurve); }

export function configureShading(
  ambient: f64, laser: f64,
  tintR: f64, tintG: f64, tintB: f64,
  stripeR: f64, stripeG: f64, stripeB: f64,
  cx: f64, cy: f64, focal: f64, maxAngle: f64,
): void {
  shadeAmbient = ambient; shadeLaser = laser;
  shadeTintR = tintR; shadeTintG = tintG; shadeTintB = tintB;
  shadeStripeR = stripeR; shadeStripeG = stripeG; shadeStripeB = stripeB;
  shadeCx = cx; shadeCy = cy; shadeFocal = focal; shadeMaxAngle = maxAngle;
  const degPerRad: f64 = 180.0 / Math.PI;
  for (let y = 0; y < HEIGHT; y++) {
    const dy = <f64>y + 0.5 - shadeCy;
    for (let x = 0; x < WIDTH; x++) {
      const dx = <f64>x + 0.5 - shadeCx;
      let t = Math.atan2(Math.sqrt(dx * dx + dy * dy), shadeFocal) * degPerRad / shadeMaxAngle;
      if (t < 0.0) t = 0.0;
      if (t > 1.0) t = 1.0;
      t *= 90.0;
      const low = <i32>Math.floor(t);
      const high = low >= 90 ? 90 : low + 1;
      const frac = t - <f64>low;
      gainField[y * WIDTH + x] = <f32>(shadingCurve[low] * (1.0 - frac) + shadingCurve[high] * frac);
    }
  }
  shadeReady = true;
}

/** Disable the transform, so the uploaded image is used as captured. */
export function clearShading(): void { shadeReady = false; }

function byte(value: f64): u8 {
  if (value <= 0.0) return 0;
  if (value >= 255.0) return 255;
  return <u8>Math.round(value);
}

/** Apply the capture transform to the uploaded image, in place. */
export function shade(): void {
  if (!shadeReady) return;
  const ambientR = shadeAmbient * shadeTintR, ambientG = shadeAmbient * shadeTintG, ambientB = shadeAmbient * shadeTintB;
  const stripeR = shadeLaser * shadeStripeR, stripeG = shadeLaser * shadeStripeG, stripeB = shadeLaser * shadeStripeB;
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * WIDTH;
    for (let x = 0; x < WIDTH; x++) {
      const at = row + x;
      const i = at * 4;
      const r = <f64>unchecked(rgba[i]), g = <f64>unchecked(rgba[i + 1]), b = <f64>unchecked(rgba[i + 2]);
      const excess = Math.max(0.0, b - Math.max(r, g));
      const k = excess * <f64>unchecked(gainField[at]);
      unchecked(rgba[i] = byte(r * ambientR + k * stripeR - excess * 0.015 * ambientR));
      unchecked(rgba[i + 1] = byte(g * ambientG + k * stripeG - excess * 0.12 * ambientG));
      unchecked(rgba[i + 2] = byte(b * ambientB - excess * ambientB + k * stripeB));
    }
  }
}
