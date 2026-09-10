/* Row-level laser gate from the trained non-laser object row model.
 *
 * Every pixel row of a scan frame is a vector of blue-excess scores. The basis
 * trained offline (tools/laser/rows-pca.py) spans the ordinary lower-half rows
 * of the object captures; the centre (mean row) is stored with it and removed
 * from every row before projection. A row that reconstructs in that basis is a
 * non-laser row; a large residual after removing the centre carries laser
 * light. The gate rejects the rows that reconstruct well, so the kernel only
 * searches the surviving span inside the calibrated ROI.
 */
export function loadRowGate(meta, buffer) {
  const dim = meta.dim, k = meta.k;
  const data = new Float32Array(buffer);
  if (!(dim > 0) || !(k > 0) || data.length < (k + 1) * dim) throw new Error('rowGate');
  return {
    dim, k, stride: meta.stride, threshold: meta.threshold,
    mean: data.subarray(0, dim),
    loadings: data.subarray(dim, dim + k * dim),
    scratch: new Float64Array(dim),
  };
}

/** Squared reconstruction residual of one delivered pixel row, with the
 * stored centre (mean row) removed before the projection. */
export function rowResidual(gate, rgba, width, y) {
  const { dim, stride, mean, loadings, k, scratch } = gate;
  const base = y * width * 4;
  let norm = 0;
  for (let c = 0; c < dim; c++) {
    const i = base + c * stride * 4;
    const blue = rgba[i + 2], green = rgba[i + 1], red = rgba[i];
    let score = blue - (red > green ? red : green);
    if (score < 0) score = 0;
    const centered = score - mean[c];
    scratch[c] = centered;
    norm += centered * centered;
  }
  let projected = 0;
  for (let j = 0; j < k; j++) {
    const offset = j * dim;
    let dot = 0;
    for (let c = 0; c < dim; c++) dot += scratch[c] * loadings[offset + c];
    projected += dot * dot;
  }
  return norm - projected;
}

/** Rows in [top, bottom) whose residual exceeds the trained threshold, as a
 * contiguous [first, last] span, or null when no row qualifies. */
export function gateSpan(gate, rgba, width, top, bottom) {
  let first = -1, last = -1;
  for (let y = top; y < bottom; y++) {
    if (rowResidual(gate, rgba, width, y) > gate.threshold) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return first < 0 ? null : [first, last];
}
