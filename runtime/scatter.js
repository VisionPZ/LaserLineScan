/* S1 — scatter-tail mixture fit and S2 — saturated-shoulder recovery.
 *
 * A transparent object adds two photometric artefacts to the laser line: a
 * broad volume/diffuse glow around the surface return, and — under specular
 * glare — a saturated core whose true centre is clipped. Both bias the line
 * centre. These helpers fit a narrow surface Gaussian over a smooth
 * scatter/background within one column's profile, and recover a saturated
 * centre from the unsaturated shoulders. They are used by the worker as a
 * fallback for columns the ridge kernel does not return.
 */

/** Score of one column from the pixel buffer, rows [top, bottom).
 *
 * Colour buffers (default) are addressed with `options.stride` bytes per pixel
 * and scored by blue excess. A monochrome sensor stores one byte per pixel and
 * has no colour, so with `options.mono` the pixel's own intensity is the score
 * at `options.stride` (default 1). Both share the row addressing
 * `p = (top + i) * width * stride + x * stride`. */
export function columnProfile(rgba, width, x, top, bottom, options = {}) {
  const stride = options.stride ?? 4, mono = options.mono ?? false;
  const profile = new Float64Array(Math.max(0, bottom - top));
  for (let i = 0; i < profile.length; i++) {
    const p = (top + i) * width * stride + x * stride;
    if (mono) profile[i] = rgba[p];
    else profile[i] = Math.max(0, rgba[p + 2] - Math.max(rgba[p], rgba[p + 1]));
  }
  return profile;
}

/** Solve a 4x4 linear system by Gaussian elimination; null when singular. */
function solve4(m, v) {
  const a = m.map((row, i) => [...row, v[i]]);
  for (let i = 0; i < 4; i++) {
    let pivot = i;
    for (let j = i + 1; j < 4; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-12) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const scale = a[i][i];
    for (let k = i; k < 5; k++) a[i][k] /= scale;
    for (let j = 0; j < 4; j++) {
      if (j === i) continue;
      const weight = a[j][i];
      for (let k = i; k < 5; k++) a[j][k] -= weight * a[i][k];
    }
  }
  return a.map(row => row[4]);
}

/** Fit `c0 + c1*y + c2*y^2 + a*G(y; centre, sigma)` over a window around the
 * peak. Returns {centre, amplitude} in profile coordinates, or null. */
export function mixtureCenter(profile, peak, options = {}) {
  const sigma = options.sigma ?? 1.2, window = options.window ?? 16;
  const n = profile.length;
  const lo = Math.max(0, peak - window), hi = Math.min(n, peak + window + 1);
  if (hi - lo < 12) return null;
  let mean = 0; for (let i = lo; i < hi; i++) mean += i; mean /= hi - lo;
  let best = null;
  for (let centre = peak - 4; centre <= peak + 4.001; centre += 0.25) {
    const m = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], rhs = [0, 0, 0, 0];
    for (let i = lo; i < hi; i++) {
      const y = i - mean, g = Math.exp(-.5 * ((i - centre) / sigma) ** 2);
      const row = [1, y, y * y, g], value = profile[i];
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) m[r][c] += row[r] * row[c];
        rhs[r] += row[r] * value;
      }
    }
    const coeff = solve4(m, rhs);
    if (!coeff) continue;
    let rss = 0;
    for (let i = lo; i < hi; i++) {
      const y = i - mean, g = Math.exp(-.5 * ((i - centre) / sigma) ** 2);
      const fit = coeff[0] + coeff[1] * y + coeff[2] * y * y + coeff[3] * g;
      rss += (profile[i] - fit) ** 2;
    }
    if (!best || rss < best.rss) best = {rss, centre, amplitude: coeff[3]};
  }
  return best ? {centre: best.centre, amplitude: best.amplitude} : null;
}

/** S2 — centre of a saturated peak from its unsaturated shoulders. Fits a
 * log-parabola to samples below `saturation` and returns null when the core
 * carries no usable shoulder information. */
export function shoulderCenter(profile, peak, saturation = 250, half = 8) {
  const n = profile.length;
  const lo = Math.max(0, peak - half), hi = Math.min(n, peak + half + 1);
  const ys = [], values = [];
  for (let i = lo; i < hi; i++) {
    const v = profile[i];
    if (v > 2 && v < saturation) { ys.push(i); values.push(Math.log(v)); }
  }
  if (ys.length < 5) return null;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], rhs = [0, 0, 0];
  for (let k = 0; k < ys.length; k++) {
    const row = [1, ys[k], ys[k] * ys[k]];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r][c] += row[r] * row[c];
      rhs[r] += row[r] * values[k];
    }
  }
  const a = m.map((row, i) => [...row, rhs[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-12) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const scale = a[i][i];
    for (let k = i; k < 4; k++) a[i][k] /= scale;
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const weight = a[j][i];
      for (let k = i; k < 4; k++) a[j][k] -= weight * a[i][k];
    }
  }
  const c2 = a[2][3], b = a[1][3];
  if (!(c2 < -1e-6)) return null;
  const centre = -b / (2 * c2);
  return centre >= lo - 1 && centre <= hi + 1 ? centre : null;
}

/** Recover columns inside the band that the ridge kernel did not return.
 * `measured` maps integer column -> ridge row; the result is an array of
 * {x, y, amplitude} in delivered pixel coordinates. A candidate is accepted
 * only when it is close to the trend of the already-measured columns, so a
 * column that is genuinely missing (occlusion, no line) is left alone. */
export function recoverColumns(rgba, width, height, band, columns, measured, options = {}) {
  const minAmplitude = options.minAmplitude ?? .15;
  const threshold = options.threshold ?? 40;
  const saturation = options.saturation ?? 250;
  const glowMin = options.glowMin ?? 2;
  const continuity = options.continuity ?? 4;
  const continuityGap = options.continuityGap ?? 8;
  const stride = options.stride ?? 4, mono = options.mono ?? false;
  const [left, right] = columns || [0, width];
  // The nearest measured column above x is fixed before the sweep: every column
  // recovered during it lies below x, so a running `below` covers the other side.
  // (A binary search over a list that keeps growing would read it unsorted, which
  // silently rejected recoverable columns.)
  const aboveAt = new Int32Array(width + 1).fill(-1);
  let nextAbove = -1;
  for (let x = width - 1; x >= 0; x--) { if (measured.has(x)) nextAbove = x; aboveAt[x] = nextAbove; }
  let below = -1;
  const expectedRow = (x, above) => {
    if (below >= 0 && above >= 0) return measured.get(below) + (measured.get(above) - measured.get(below)) * (x - below) / (above - below);
    if (below >= 0) return measured.get(below);
    if (above >= 0) return measured.get(above);
    return null;
  };
  const out = [];
  for (let x = Math.max(0, left); x < Math.min(width, right); x++) {
    if (measured.has(x)) { below = x; continue; }
    const above = aboveAt[x];
    const top = Math.max(0, band.top[x] - 8), bottom = Math.min(height, band.bottom[x] + 8);
    if (bottom - top < 12) continue;
    let peak = -1, at = 0;
    for (let y = top; y < bottom; y++) {
      const p = y * width * stride + x * stride;
      const value = mono ? rgba[p] : Math.max(0, rgba[p + 2] - Math.max(rgba[p], rgba[p + 1]));
      if (value > peak) { peak = value; at = y; }
    }
    if (peak <= threshold) continue;
    const profile = columnProfile(rgba, width, x, top, bottom, {stride, mono});
    let total = 0, pmax = 0;
    for (let i = 0; i < profile.length; i++) { total += profile[i]; if (profile[i] > pmax) pmax = profile[i]; }
    if ((total - pmax) / Math.max(1, pmax) < glowMin) continue;
    const local = at - top;
    const saturated = profile.filter(v => v >= saturation).length >= 2;
    let centre = null;
    if (saturated && options.shoulder !== false) centre = shoulderCenter(profile, local, saturation);
    if (centre === null) {
      const fit = mixtureCenter(profile, local, options);
      if (fit && fit.amplitude > minAmplitude * peak) centre = fit.centre;
    }
    if (centre === null || !Number.isFinite(centre)) continue;
    const row = top + centre + .5;
    const gap = Math.min(below >= 0 ? x - below : Infinity, above >= 0 ? above - x : Infinity);
    if (gap > continuityGap) continue;
    const expected = expectedRow(x, above);
    if (expected !== null && Math.abs(row - expected) > continuity) continue;
    measured.set(x, row);
    below = x;
    out.push({x: x + .5, y: row, amplitude: peak});
  }
  return out;
}
