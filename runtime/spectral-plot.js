// SPDX-License-Identifier: GPL-3.0-or-later

/* Scientific spectrum plot for the step-0 design tool.
 *
 * A crisp 2-D canvas rather than a GPU pass: the plot is 125 samples wide and
 * needs readable tick text, so the GPU budget stays with the frame transform in
 * spectral-gl.js. The x axis is wavelength in nanometres, the y axis a shared
 * relative magnitude; tick values are language-independent, only the axis
 * titles and the legend are translated.
 *
 * Every colour comes from the active theme: the tokens below are read off the
 * canvas at draw time and re-read when `data-theme` changes, so the plot matches
 * the user's light or dark choice like the rest of the lab.
 */

import {WAVELENGTHS, LAMBDA_MIN, LAMBDA_MAX, wavelengthColor} from './spectral.js';

const MARGIN = {left: 60, right: 30, top: 18, bottom: 40};
const Y_MAX = 1.04;
const MIN_SPAN = 20;
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

const TOKENS = [
  '--ll-plot-bg', '--ll-plot-grid', '--ll-plot-grid-minor', '--ll-plot-axis',
  '--ll-plot-tick', '--ll-plot-title', '--ll-plot-cursor',
  '--ll-series-laser', '--ll-series-detected', '--ll-series-filter',
  '--ll-series-ambient', '--ll-series-qe', '--ink',
];
const FALLBACK = {
  '--ll-plot-bg': '#0A0E1D', '--ll-plot-grid': 'rgba(148,163,184,.22)',
  '--ll-plot-grid-minor': 'rgba(148,163,184,.08)', '--ll-plot-axis': 'rgba(148,163,184,.5)',
  '--ll-plot-tick': '#9aa6bd', '--ll-plot-title': '#8f9ab2', '--ll-plot-cursor': 'rgba(226,232,240,.5)',
  '--ll-series-laser': '#5bb0ff', '--ll-series-detected': '#cbb6ff', '--ll-series-filter': '#f5b942',
  '--ll-series-ambient': '#b9c6d6', '--ll-series-qe': '#6ee7a0', '--ink': '#F5F6FF',
};

const SERIES = [
  {key: 'laser', label: 'laserLine', token: '--ll-series-laser', width: 2.4, fill: true},
  {key: 'detected', label: 'detectedSignal', token: '--ll-series-detected', width: 1.6, dash: [5, 4]},
  {key: 'filter', label: 'filterBand', token: '--ll-series-filter', width: 1.8},
  {key: 'ambient', label: 'ambientLabel', token: '--ll-series-ambient', width: 1.4},
  {key: 'qe', label: 'sensorResponse', token: '--ll-series-qe', width: 1.8},
];

export class SpectrumPlot {
  constructor(canvas, {onHover, onAddPoint, onMenu, onMovePoint, onCommit, onView, labels = {}} = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover;
    this.onAddPoint = onAddPoint;
    this.onMenu = onMenu;
    this.onMovePoint = onMovePoint;
    this.onCommit = onCommit;
    this.onView = onView;
    this.labels = labels;
    this.model = null;
    this.visible = {};
    this.controls = {};
    this.view = {x0: LAMBDA_MIN, x1: LAMBDA_MAX};
    this.hover = null;
    this.hoverPoint = null;
    // Which curve's knots are drawn and editable. Editing one spectrum at a
    // time keeps a right click from landing on a curve the user did not mean.
    this.editSeries = 'laser';
    this.dragPoint = null;
    this.selectedPoint = null;
    this.size = {width: 0, height: 0};
    this.drag = null;
    this.theme = {};
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(canvas.parentElement || canvas);
    canvas.addEventListener('wheel', event => this.onWheel(event), {passive: false});
    canvas.addEventListener('pointerdown', event => this.onDown(event));
    canvas.addEventListener('pointermove', event => this.onMove(event));
    canvas.addEventListener('pointerup', event => this.onUp(event));
    canvas.addEventListener('contextmenu', event => this.onContextMenu(event));
    canvas.addEventListener('pointerleave', () => {if (this.dragPoint) return; this.drag = null; this.hover = null; this.hoverPoint = null; this.draw(); this.emit();});
    canvas.addEventListener('dblclick', () => this.reset());
    // The site switches `data-theme` on <html>; re-read the tokens when it does.
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      this.themeObserver = new MutationObserver(() => this.layout());
      this.themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
    }
    this.layout();
  }

  setModel(model) { this.model = model; this.draw(); }
  /** Choose the editable spectrum; the plot always edits exactly one. */
  setEditSeries(series) {
    if (!EDITABLE.includes(series)) return;
    this.editSeries = series;
    this.hoverPoint = null;
    this.selectedPoint = null;
    this.canvas.dataset.editSeries = series;
    this.draw();
  }

  setControlPoints(controls) { this.controls = controls || {}; this.canvas.dataset.controls = String(Object.values(this.controls).reduce((n, list) => n + (list ? list.length : 0), 0)); this.draw(); }
  setVisible(visible) { this.visible = visible; this.draw(); }
  setLabels(labels) { this.labels = labels; this.draw(); }
  seriesColor(series) { return this.theme[series.token] || FALLBACK[series.token]; }

  /** Re-read the theme tokens the plot draws with. */
  resolveTheme() {
    const styles = (typeof getComputedStyle === 'function') ? getComputedStyle(this.canvas) : null;
    this.theme = {};
    for (const token of TOKENS) {
      const value = styles ? (styles.getPropertyValue(token) || '').trim() : '';
      this.theme[token] = value || FALLBACK[token];
    }
  }

  reset() { this.view = {x0: LAMBDA_MIN, x1: LAMBDA_MAX}; this.draw(); this.notifyView(); }
  notifyView() { if (this.onView) this.onView({x0: this.view.x0, x1: this.view.x1}); }
  zoomBy(factor) {
    const mid = (this.view.x0 + this.view.x1) / 2, span = (this.view.x1 - this.view.x0) / 2 / factor;
    this.setSpan(mid - span, mid + span);
  }
  get zoomed() { return this.view.x0 > LAMBDA_MIN + 1e-6 || this.view.x1 < LAMBDA_MAX - 1e-6; }

  setSpan(x0, x1) {
    const span = Math.min(LAMBDA_MAX - LAMBDA_MIN, Math.max(MIN_SPAN, x1 - x0));
    let a = x0, b = x0 + span;
    if (a < LAMBDA_MIN) {a = LAMBDA_MIN; b = LAMBDA_MIN + span;}
    if (b > LAMBDA_MAX) {b = LAMBDA_MAX; a = LAMBDA_MAX - span;}
    this.view = {x0: a, x1: b};
    this.draw();
    this.notifyView();
  }

  layout() {
    const parent = this.canvas.parentElement || this.canvas;
    const rect = parent.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 320));
    const height = Math.max(200, Math.round(width * 0.44));
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    this.size = {width, height};
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.resolveTheme();
    this.draw();
    this.notifyView();
  }

  /* --------------------------------------------------------------- mapping */
  plot() {
    const {width, height} = this.size;
    return {x: MARGIN.left, y: MARGIN.top, w: width - MARGIN.left - MARGIN.right, h: height - MARGIN.top - MARGIN.bottom};
  }
  toX(nm) { const p = this.plot(); return p.x + (nm - this.view.x0) / (this.view.x1 - this.view.x0) * p.w; }
  toNm(px) { const p = this.plot(); return this.view.x0 + (px - p.x) / p.w * (this.view.x1 - this.view.x0); }
  toY(value) { const p = this.plot(); return p.y + p.h - Math.min(value, Y_MAX) / Y_MAX * p.h; }
  toValue(py) { const p = this.plot(); return Math.max(0, Math.min(1, (p.y + p.h - py) / p.h * Y_MAX)); }

  /* ----------------------------------------------------------- hit testing */
  pointAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let best = null, bestDistance = 10;
    for (const series of [this.editSeries]) {
      if (this.visible[series] === false) continue;
      const list = this.controls[series];
      if (!list) continue;
      list.forEach((point, index) => {
        const distance = Math.hypot(this.toX(point.nm) - x, this.toY(point.value) - y);
        if (distance < bestDistance) { bestDistance = distance; best = {series, index}; }
      });
    }
    return best;
  }

  /** The editable curve nearest the cursor, and the wavelength under it. */
  curveAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const p = this.plot();
    if (x < p.x || x > p.x + p.w) return null;
    const nm = this.toNm(x);
    // A right click anywhere inside the plot adds a knot to the picked series,
    // so the click does not have to land on the curve itself.
    if (this.visible[this.editSeries] === false) return null;
    if (!this.model || !this.model[this.editSeries]) return null;
    return {series: this.editSeries, nm};

  }

  /** The wavelength the cursor line marks: the pointer, else the chosen knot. */
  indicator() {
    if (this.hover) return this.hover.nm;
    const selected = this.selectedPoint;
    const list = selected && this.controls[selected.series];
    const point = list && list[selected.index];
    return point ? point.nm : null;
  }

  /* --------------------------------------------------------------- drawing */
  draw() {
    const ctx = this.ctx, {width, height} = this.size, p = this.plot();
    if (!width) return;
    // Expose the visible range so the browser checks can assert the zoom.
    this.canvas.dataset.view = `${this.view.x0.toFixed(1)}-${this.view.x1.toFixed(1)}`;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.theme['--ll-plot-bg'];
    ctx.fillRect(p.x, p.y, p.w, p.h);
    this.drawGrid(p);
    this.drawSeries(p);
    this.drawAxes(p);
    this.drawHover(p);
    this.drawControls(p);
  }

  drawGrid(p) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x, p.y, p.w, p.h);
    ctx.clip();
    const major = niceStep((this.view.x1 - this.view.x0) / 8);
    const minor = major / 5;
    ctx.lineWidth = 1;
    for (let nm = Math.ceil(this.view.x0 / minor) * minor; nm <= this.view.x1 + 1e-6; nm += minor) {
      const x = Math.round(this.toX(nm)) + 0.5;
      const isMajor = Math.abs(nm / major - Math.round(nm / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? this.theme['--ll-plot-grid'] : this.theme['--ll-plot-grid-minor'];
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
    }
    for (let v = 0; v <= Y_MAX + 1e-9; v += 0.125) {
      const y = Math.round(this.toY(v)) + 0.5;
      const isMajor = Math.abs(v / 0.25 - Math.round(v / 0.25)) < 1e-6;
      ctx.strokeStyle = isMajor ? this.theme['--ll-plot-grid'] : this.theme['--ll-plot-grid-minor'];
      ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
    }
    ctx.restore();
  }

  drawSeries(p) {
    if (!this.model) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x, p.y, p.w, p.h);
    ctx.clip();
    for (const series of SERIES) {
      if (this.visible[series.key] === false) continue;
      const values = this.model[series.key];
      if (!values) continue;
      const color = series.key === 'laser' ? laserStroke(this.model, this.theme) : this.seriesColor(series);
      const path = new Path2D();
      let first = true;
      for (let b = 0; b < WAVELENGTHS.length; b++) {
        const nm = WAVELENGTHS[b];
        if (nm < this.view.x0 - 1 || nm > this.view.x1 + 1) continue;
        const x = this.toX(nm), y = this.toY(values[b]);
        first ? path.moveTo(x, y) : path.lineTo(x, y);
        first = false;
      }
      if (series.fill) {
        const area = new Path2D(path);
        area.lineTo(this.toX(Math.min(this.view.x1, WAVELENGTHS[WAVELENGTHS.length - 1])), p.y + p.h);
        area.lineTo(this.toX(Math.max(this.view.x0, WAVELENGTHS[0])), p.y + p.h);
        area.closePath();
        ctx.fillStyle = rgba(color, 0.16, this.theme['--ll-plot-bg']);
        ctx.fill(area);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = series.width;
      ctx.lineJoin = 'round';
      ctx.setLineDash(series.dash || []);
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  drawAxes(p) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.theme['--ll-plot-axis'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
    ctx.lineTo(Math.round(p.x) + 0.5, Math.round(p.y + p.h) + 0.5);
    ctx.lineTo(Math.round(p.x + p.w) + 0.5, Math.round(p.y + p.h) + 0.5);
    ctx.stroke();
    ctx.font = FONT;
    ctx.fillStyle = this.theme['--ll-plot-tick'];
    const major = niceStep((this.view.x1 - this.view.x0) / 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let nm = Math.ceil(this.view.x0 / major) * major; nm <= this.view.x1 + 1e-6; nm += major) {
      const x = this.toX(nm);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, p.y + p.h); ctx.lineTo(Math.round(x) + 0.5, p.y + p.h + 4); ctx.stroke();
      // Keep the first and last label inside the reserved right margin.
      ctx.fillText(formatTick(nm, major), Math.max(p.x + 14, Math.min(p.x + p.w - 14, x)), p.y + p.h + 8);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= 1.0001; v += 0.25) {
      const y = this.toY(v);
      ctx.beginPath(); ctx.moveTo(p.x - 4, Math.round(y) + 0.5); ctx.lineTo(p.x, Math.round(y) + 0.5); ctx.stroke();
      ctx.fillText(v.toFixed(2), p.x - 8, y);
    }
    // Axis titles are translated text, drawn inside the reserved margins.
    ctx.fillStyle = this.theme['--ll-plot-title'];
    ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.labels.x || 'Wavelength (nm)', p.x + p.w / 2, this.size.height - 8);
    ctx.save();
    ctx.translate(14, p.y + p.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'top';
    ctx.fillText(this.labels.y || 'Relative magnitude', 0, 0);
    ctx.restore();
  }

  /**
   * The wavelength cursor: a dim grey dashed vertical while the pointer is in
   * the plot or a control point is selected, with that wavelength written on the
   * x axis so the value under the cursor is readable without measuring ticks.
   */
  drawHover(p) {
    const nm = this.indicator();
    if (nm === null || !this.model) { delete this.canvas.dataset.indicator; return; }
    const x = this.toX(nm);
    if (x < p.x - 1 || x > p.x + p.w + 1) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = this.theme['--ll-plot-cursor'];
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, p.y);
    ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (this.hover) {
      for (const series of SERIES) {
        if (this.visible[series.key] === false) continue;
        const values = this.model[series.key];
        if (!values) continue;
        const color = series.key === 'laser' ? laserStroke(this.model, this.theme) : this.seriesColor(series);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, this.toY(sampleAt(values, nm)), 2.6, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    this.drawIndicatorLabel(p, x, nm);
    this.canvas.dataset.indicator = nm.toFixed(1);
  }

  drawIndicatorLabel(p, x, nm) {
    const ctx = this.ctx;
    const text = formatTick(nm, (this.view.x1 - this.view.x0) < 60 ? 0.1 : 1);
    ctx.save();
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const width = ctx.measureText(text).width + 8;
    const centre = Math.max(p.x + width / 2, Math.min(p.x + p.w - width / 2, x));
    // A tick at the true position, and the number on top of the static ticks.
    ctx.strokeStyle = this.theme['--ll-plot-cursor'];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, p.y + p.h);
    ctx.lineTo(Math.round(x) + 0.5, p.y + p.h + 5);
    ctx.stroke();
    ctx.fillStyle = this.theme['--ll-plot-bg'];
    ctx.fillRect(centre - width / 2, p.y + p.h + 6, width, 13);
    ctx.fillStyle = this.theme['--ink'];
    ctx.fillText(text, centre, p.y + p.h + 8);
    ctx.restore();
  }

  /** Editable hand-placed knots, drawn over the curves they shape. */
  drawControls(p) {
    if (!this.model) return;
    const ctx = this.ctx;
    const background = this.theme['--ll-plot-bg'], ink = this.theme['--ink'];
    let drawn = 0;
    for (const series of [this.editSeries]) {
      if (this.visible[series] === false) continue;
      const list = this.controls[series];
      if (!list || !list.length) continue;
      const colour = series === 'laser' ? laserStroke(this.model, this.theme) : this.seriesColor(SERIES.find(s => s.key === series));
      list.forEach((point, index) => {
        const x = this.toX(point.nm), y = this.toY(point.value);
        if (x < p.x - 8 || x > p.x + p.w + 8) return;
        const active = (this.dragPoint && this.dragPoint.series === series && this.dragPoint.index === index)
          || (this.selectedPoint && this.selectedPoint.series === series && this.selectedPoint.index === index)
          || (this.hoverPoint && this.hoverPoint.series === series && this.hoverPoint.index === index);
        ctx.beginPath();
        ctx.arc(x, y, active ? 5.5 : 4, 0, Math.PI * 2);
        ctx.fillStyle = active ? ink : colour;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = active ? colour : background;
        ctx.stroke();
        drawn += 1;
      });
    }
    // Exposed so the browser checks can see which series is being edited.
    this.canvas.dataset.editKnots = String(drawn);
  }

  /* --------------------------------------------------------------- input */
  onWheel(event) {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const nm = this.toNm(event.clientX - rect.left);
    const factor = Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.0016);
    const span = (this.view.x1 - this.view.x0) / factor;
    const t = (nm - this.view.x0) / (this.view.x1 - this.view.x0);
    this.setSpan(nm - span * t, nm + span * (1 - t));
  }

  onDown(event) {
    // Only the left button pans or drags, so a right click never starts a
    // gesture before the context menu opens.
    if (event.button !== 0) return;
    // A left press on a handle drags that control point instead of panning.
    const point = this.pointAt(event.clientX, event.clientY);
    if (point) {
      this.dragPoint = point;
      this.canvas.setPointerCapture(event.pointerId);
      this.canvas.style.cursor = 'grabbing';
      this.draw();
      return;
    }
    this.drag = {x: event.clientX, x0: this.view.x0, x1: this.view.x1};
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
  }

  onMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (this.dragPoint) {
      const nm = this.toNm(event.clientX - rect.left);
      const value = this.toValue(event.clientY - rect.top);
      if (this.onMovePoint) this.onMovePoint({...this.dragPoint, nm, value});
      return;
    }
    if (this.drag) {
      const p = this.plot();
      const shift = (this.drag.x - event.clientX) / p.w * (this.drag.x1 - this.drag.x0);
      this.setSpan(this.drag.x0 + shift, this.drag.x1 + shift);
      return;
    }
    this.hoverPoint = this.pointAt(event.clientX, event.clientY);
    const nm = Math.max(this.view.x0, Math.min(this.view.x1, this.toNm(event.clientX - rect.left)));
    this.hover = {nm, x: event.clientX - rect.left};
    this.canvas.style.cursor = this.hoverPoint ? 'grab' : 'crosshair';
    this.draw();
    this.emit();
  }

  onUp(event) {
    if (this.dragPoint) {
      this.dragPoint = null;
      this.canvas.style.cursor = 'crosshair';
      if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (this.onCommit) this.onCommit();
      this.draw();
      return;
    }
    this.drag = null;
    this.canvas.style.cursor = 'crosshair';
    if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  }

  /** Right click adds a point on the curve, or opens the menu over a handle. */
  onContextMenu(event) {
    event.preventDefault();
    const point = this.pointAt(event.clientX, event.clientY);
    if (point) {
      if (this.onMenu) this.onMenu({...point, clientX: event.clientX, clientY: event.clientY});
      return;
    }
    const curve = this.curveAt(event.clientX, event.clientY);
    if (curve && this.onAddPoint) this.onAddPoint(curve);
  }

  emit() {
    if (!this.onHover || !this.model) return;
    if (!this.hover) { this.onHover(null); return; }
    const values = {};
    for (const series of SERIES) {
      if (this.visible[series.key] === false) continue;
      const curve = this.model[series.key];
      if (curve) values[series.key] = sampleAt(curve, this.hover.nm);
    }
    this.onHover({nm: this.hover.nm, values});
  }

  destroy() {
    this.resize.disconnect();
    if (this.themeObserver) this.themeObserver.disconnect();
  }
}

function niceStep(rough) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250];
  const target = Math.max(1, rough);
  return steps.find(step => step >= target) || 500;
}

function formatTick(nm, step) {
  return step < 1 ? nm.toFixed(1) : String(Math.round(nm));
}

export function sampleAt(curve, nm) {
  const t = (nm - WAVELENGTHS[0]) / (WAVELENGTHS[WAVELENGTHS.length - 1] - WAVELENGTHS[0]) * (WAVELENGTHS.length - 1);
  const i0 = Math.max(0, Math.min(WAVELENGTHS.length - 1, Math.floor(t)));
  const i1 = Math.min(WAVELENGTHS.length - 1, i0 + 1);
  return curve[i0] * (1 - (t - i0)) + curve[i1] * (t - i0);
}

/** The laser curve takes the designed colour, kept bright enough to read. */
function laserStroke(model, theme) {
  const base = model.stripeColor || [0.35, 0.6, 1];
  const peak = Math.max(...base) || 1;
  const lifted = base.map(v => 0.42 + 0.58 * (v / peak));
  const scale = 1 / (Math.max(...lifted) || 1);
  return `rgb(${lifted.map(v => Math.round(Math.min(1, v * scale) * 255)).join(',')})`;
}

/** Translucent version of a stroke colour, falling back when it is a hex. */
function rgba(color, alpha, background) {
  const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color)
    || (color.startsWith('#') && color.length === 7
      ? [String(parseInt(color.slice(1, 3), 16)), String(parseInt(color.slice(3, 5), 16)), String(parseInt(color.slice(5, 7), 16))]
      : null);
  if (!rgb) return background;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

export {SERIES as SPECTRUM_SERIES, wavelengthColor};

/** Series a control point can be placed on; `detected` is derived, not drawn. */
export const EDITABLE = ['laser', 'filter', 'ambient', 'qe'];
