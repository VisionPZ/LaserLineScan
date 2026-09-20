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
 *   demo/calibration/charuco-moving-board/   12 frames + preview + manifest
 *   demo/calibration/charuco-fixed-board/    12 frames + preview + manifest
 *   demo/validation/charuco-moving-board/bin/ 12 frames + 12 truth volumes
 *   demo/validation/charuco-fixed-board/bin/  40 frames + 1 shared truth volume
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

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');
const sourceRoot = join(repoRoot, 'public/laser/hd');
const outputRoot = join(packageRoot, 'demo');
const frameCount = Number(process.env.DEMO_FRAMES || 12);
const validationFrameCount = Number(process.env.DEMO_VALIDATION_FRAMES || 40);

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

/** Copy one calibration split: 12 frames, its preview and a trimmed manifest. */
function buildCalibration(rig) {
  const source = join(sourceRoot, 'calibration', rig);
  const dest = join(outputRoot, 'calibration', rig);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
  const total = manifest.calibration.length;
  const indices = pickEven(total, frameCount);
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
  // A shared validation truth volume is copied once; per-frame volumes travel
  // with the frames that reference them, so no manifest promises an absent file.
  if (manifest.validationTruth) {
    requireFile(join(source, manifest.validationTruth));
    copy(join(source, manifest.validationTruth), join(dest, manifest.validationTruth));
  }
  for (const frame of selected) {
    if (!frame.truth) continue;
    requireFile(join(source, frame.truth));
    copy(join(source, frame.truth), join(dest, frame.truth));
  }
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
  buildValidation('charuco-moving-board', 'bin', 12),
  buildValidation('charuco-fixed-board', 'bin'),
];

console.log(`Demo dataset written to ${outputRoot}`);
for (const r of results) {
  const where = r.scene ? `${r.rig}/${r.scene}` : r.rig;
  const extra = r.truth ? ` truth=${r.truth}` : '';
  console.log(`  ${where}: ${r.frames}/${r.total} frames${extra}`);
}
console.log(`Total demo size: ${mib(directorySize(outputRoot))}`);
