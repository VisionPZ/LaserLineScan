#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * make-demo-dataset.mjs — build the small, self-contained demo dataset shipped
 * with laser-line-scan.
 *
 * The upstream site keeps its capture sequences under public/laser/hd/ (about
 * 2.6 GB). The standalone package must not ship that, so this script copies a
 * small, honest subset of the already-rendered frames into demo/ and rewrites
 * each manifest.json so every frame array, truth path and count matches the
 * files that are actually present.
 *
 * Layout produced (mirrors the runtime's `demo/<split>/<rig>/<scene>/` paths):
 *
 *   demo/calibration/charuco-moving-board/   50 frames + preview + manifest
 *   demo/calibration/charuco-fixed-board/    50 frames + preview + manifest
 *   demo/validation/<rig>/bin/               12 (moving) / 40 (fixed) frames
 *   demo/validation/charuco-moving-board/<scene>/ 12 frames + 12 truth volumes
 *   demo/validation/charuco-fixed-board/<scene>/  24 frames + 1 shared truth
 *
 * Every scene the lab can offer ships with the demo, because a card that
 * cannot be scanned is worse than no card at all. The extra scenes carry fewer
 * lines than `bin`: the moving rig stores one truth volume per line (~0.35 MiB quantised
 * each, and the volume only describes the camera pose of that line, so it
 * cannot be shared), which is what keeps the whole demo near 100 MiB.
 *
 * The fixed-board validation split carries more frames: the kernel returns at
 * most one stripe point per image column, so 12 frames of a 1920 px image can
 * never reach the >30000-point end-to-end assertion. The moving-board split
 * needs a per-frame truth volume (the camera translates), so it stays at 12.
 *
 * Run from anywhere:  node tools/make-demo-dataset.mjs
 * Optional:           DEMO_FRAMES=12 DEMO_VALIDATION_FRAMES=40 node ...
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');
const sourceRoot = join(repoRoot, 'public/laser/hd');
/** `DEMO_OUT` lets the website build generate straight into dist/laser/hd. */
const outputRoot = process.env.DEMO_OUT ? resolve(process.env.DEMO_OUT) : join(packageRoot, 'demo');
/** A frame count of `all` packages the whole rendered sequence. */
const count = (value, fallback) =>
  value === 'all' ? Number.MAX_SAFE_INTEGER : Number(value || fallback);
const calibrationFrameCount = count(process.env.DEMO_CALIBRATION_FRAMES, 50);
const validationFrameCount = count(process.env.DEMO_VALIDATION_FRAMES, 40);
const movingSceneFrameCount = count(process.env.DEMO_MOVING_SCENE_FRAMES, 12);
const fixedSceneFrameCount = count(process.env.DEMO_FIXED_SCENE_FRAMES, 24);
/** Scenes offered by the scan step; `bin` ships the full-size demo set. */
const sceneIds = ['bin', 'bottles', 'bridge', 'rail', 'plush'];
/** Truth volumes ship quantised: the scan keeps z in [1,8] units and 0 means
 *  "no data", so a uint16 count holds 8.5 units with a 0.13 mm quantum — far
 *  below the ~0.25 mm shape error the scan reports, at a third of the bytes. */
const TRUTH_SCALE = 8.5 / 65534;
const TRUTH_ENCODING = { type: 'u16', scale: TRUTH_SCALE };
/** Write a gzipped float32 depth volume as gzipped uint16; returns the new name. */
function quantiseTruth(sourceRoot, destRoot, name) {
  const raw = gunzipSync(readFileSync(join(sourceRoot, name)));
  const values = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const counts = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    counts[i] = v > 0 ? Math.max(1, Math.min(65535, Math.round(v / TRUTH_SCALE))) : 0;
  }
  const out = name.replace(/\.f32\.gz$/, '.u16.gz');
  mkdirSync(destRoot, { recursive: true });
  writeFileSync(join(destRoot, out), gzipSync(Buffer.from(counts.buffer, counts.byteOffset, counts.byteLength), { level: 6 }));
  return out;
}

/** Evenly spaced indices over `total`, always including the first frame. */
function pickEven(total, count) {
  if (count >= total) return Array.from({ length: total }, (_, i) => i);
  return Array.from({ length: count }, (_, i) => Math.round((i * (total - 1)) / (count - 1)));
}

function requireFile(file) {
  if (!existsSync(file)) throw new Error(`Missing input: ${file}`);
}

function copy(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function rewriteCalibration(manifest, selected, original) {
  manifest.calibration = selected;
  manifest.boardMetrics = { ...manifest.boardMetrics, frameCount: selected.length };
  if (manifest.selection) {
    manifest.selection = {
      ...manifest.selection,
      selectedFrames: selected.length,
      method: `${manifest.selection.method} (standalone demo: ${selected.length} of ${original} rendered poses)`,
    };
  }
  delete manifest.download;
  delete manifest.downloadBytes;
}

function rewriteValidation(manifest, selected, original) {
  manifest.validation = selected;
  manifest.lineCount = selected.length;
  manifest.scanMotion = manifest.scanMotion
    ? `${manifest.scanMotion} (standalone demo: ${selected.length} of ${original} rendered lines)`
    : manifest.scanMotion;
  delete manifest.download;
  delete manifest.downloadBytes;
}

/** Copy one calibration split: the full pose set, its preview and a trimmed manifest.
 *
 * Calibration ships every rendered pose (50): the fit is the product's core, and
 * a dozen poses noticeably change the residual the page reports.
 */
function buildCalibration(rig) {
  const source = join(sourceRoot, 'calibration', rig);
  const dest = join(outputRoot, 'calibration', rig);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  const total = manifest.calibration.length;
  const indices = pickEven(total, calibrationFrameCount);
  const selected = indices.map((i) => manifest.calibration[i]);
  for (const frame of selected) {
    requireFile(join(source, frame.file));
    copy(join(source, frame.file), join(dest, frame.file));
  }
  copy(join(source, 'preview.webp'), join(dest, 'preview.webp'));
  rewriteCalibration(manifest, selected, total);
  writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { rig, frames: selected.length, total };
}

/** Copy one validation split: frames, its preview, truth and a trimmed manifest. */
function buildValidation(rig, scene, count = validationFrameCount) {
  const source = join(sourceRoot, 'validation', rig, scene);
  const dest = join(outputRoot, 'validation', rig, scene);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  const total = manifest.validation.length;
  // A fixed-board calibration fits an encoder map whose bounds are the min/max
  // command positions it observed. Keep the shipped validation lines inside
  // those bounds so the runtime never has to extrapolate the map.
  let eligible = manifest.validation.map((_, i) => i);
  const calibrationPath = join(outputRoot, 'calibration', rig, 'manifest.json');
  if (existsSync(calibrationPath)) {
    const calibration = JSON.parse(readFileSync(calibrationPath, 'utf8'));
    const positions = calibration.calibration.map((f) => f.commandPosition).filter(Array.isArray);
    if (positions.length) {
      const bounds = [0, 1].map((axis) => [Math.min(...positions.map((p) => p[axis])), Math.max(...positions.map((p) => p[axis]))]);
      eligible = eligible.filter((i) => {
        const p = manifest.validation[i].commandPosition;
        return p && p.every((v, axis) => v >= bounds[axis][0] - 1e-5 && v <= bounds[axis][1] + 1e-5);
      });
    }
  }
  const indices = pickEven(eligible.length, count).map((k) => eligible[k]);
  const selected = indices.map((i) => manifest.validation[i]);
  for (const frame of selected) {
    requireFile(join(source, frame.file));
    copy(join(source, frame.file), join(dest, frame.file));
  }
  copy(join(source, 'preview.webp'), join(dest, 'preview.webp'));
  // Truth volumes ship quantised to uint16; every reference in the packaged
  // manifest is rewritten to the file that actually travelled.
  if (manifest.validationTruth) {
    requireFile(join(source, manifest.validationTruth));
    manifest.validationTruth = quantiseTruth(source, dest, manifest.validationTruth);
  }
  for (const frame of selected) {
    if (!frame.truth) continue;
    requireFile(join(source, frame.truth));
    frame.truth = quantiseTruth(source, dest, frame.truth);
  }
  manifest.truthEncoding = TRUTH_ENCODING;
  rewriteValidation(manifest, selected, total);
  writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { rig, scene, frames: selected.length, total, truth: manifest.validationTruth ? 'shared' : 'per-frame' };
}

function directorySize(dir, seen = new Set()) {
  if (!existsSync(dir)) return 0;
  const stat = statSync(dir);
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    const key = statSync(child).isDirectory() ? child : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    total += directorySize(child, seen);
  }
  return total;
}

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const results = [
  buildCalibration('charuco-moving-board'),
  buildCalibration('charuco-fixed-board'),
  ...sceneIds.map((scene) => buildValidation('charuco-moving-board', scene, movingSceneFrameCount)),
  ...sceneIds.map((scene) =>
    buildValidation('charuco-fixed-board', scene, scene === 'bin' ? validationFrameCount : fixedSceneFrameCount),
  ),
];

console.log(`Demo dataset written to ${outputRoot}`);
for (const r of results) {
  const where = r.scene ? `${r.rig}/${r.scene}` : r.rig;
  const extra = r.truth ? ` truth=${r.truth}` : '';
  console.log(`  ${where}: ${r.frames}/${r.total} frames${extra}`);
}
console.log(`Total demo size: ${mib(directorySize(outputRoot))}`);
