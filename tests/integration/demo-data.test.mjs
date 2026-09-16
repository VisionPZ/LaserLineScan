// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
/*
 * Deep integrity tests for the demo dataset shipped inside the package:
 * every manifest must account for every frame on disk (and vice versa), truth
 * volumes must resolve, the expected splits and previews must exist, declared
 * frame counts must match, and the dataset ids the prebuilt page offers must
 * match the directories that are actually present. Assertions report counts so
 * a failure points at the offending manifest instead of "expected true".
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoRoot = join(packageRoot, 'demo');

// The four splits the prebuilt page and the browser probe rely on.
const EXPECTED_SPLITS = [
  'calibration/charuco-moving-board',
  'calibration/charuco-fixed-board',
  'validation/charuco-moving-board/bin',
  'validation/charuco-fixed-board/bin',
];

function manifestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...manifestFiles(path));
    else if (entry.name === 'manifest.json') found.push(path);
  }
  return found.sort();
}

function readManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const split = manifest.calibration ? 'calibration' : 'validation';
  const frames = manifest[split];
  assert.ok(Array.isArray(frames) && frames.length > 0, `${path}: no ${split} frame array`);
  return { manifest, split, frames };
}

const manifests = manifestFiles(demoRoot);

test(`demo ships at least the four expected manifests (found ${manifests.length})`, () => {
  for (const relative of EXPECTED_SPLITS) {
    assert.ok(existsSync(join(demoRoot, relative)), `missing expected split demo/${relative}`);
  }
  assert.ok(manifests.length >= EXPECTED_SPLITS.length, `expected >= ${EXPECTED_SPLITS.length} manifests, found ${manifests.length}`);
});

test('every manifest lists exactly the .jpg frames on disk and every listed frame exists', () => {
  for (const path of manifests) {
    const { frames } = readManifest(path);
    const dir = dirname(path);
    const listed = new Set(frames.map((frame) => frame.file));
    const onDisk = readdirSync(dir).filter((name) => name.endsWith('.jpg'));
    const missing = [...listed].filter((file) => !existsSync(join(dir, file)));
    const unlisted = onDisk.filter((file) => !listed.has(file));
    assert.deepEqual(missing, [], `${path}: listed files missing on disk (${missing.length}/${listed.size})`);
    assert.deepEqual(
      unlisted.sort(),
      [],
      `${path}: .jpg files on disk but not listed (${unlisted.length} unlisted, ${listed.size} listed, ${onDisk.length} on disk)`,
    );
    assert.equal(listed.size, frames.length, `${path}: duplicate frame names in manifest`);
  }
});

test('every referenced truth volume resolves on disk', () => {
  for (const path of manifests) {
    const { manifest, frames } = readManifest(path);
    const dir = dirname(path);
    if (manifest.validationTruth) {
      assert.ok(
        existsSync(join(dir, manifest.validationTruth)),
        `${path}: shared validationTruth ${manifest.validationTruth} missing`,
      );
    }
    for (const frame of frames) {
      if (!frame.truth) continue;
      assert.ok(existsSync(join(dir, frame.truth)), `${path}: frame ${frame.file} truth ${frame.truth} missing`);
    }
  }
});

test('each manifest directory ships a preview.webp', () => {
  for (const path of manifests) {
    assert.ok(existsSync(join(dirname(path), 'preview.webp')), `${path}: missing preview.webp`);
  }
});

test('declared frame counts match the manifest arrays', () => {
  for (const path of manifests) {
    const { manifest, split, frames } = readManifest(path);
    if (split === 'validation') {
      assert.equal(manifest.lineCount, frames.length, `${path}: lineCount ${manifest.lineCount} != ${frames.length} validation frames`);
    }
    if (manifest.boardMetrics && typeof manifest.boardMetrics.frameCount === 'number') {
      assert.equal(
        manifest.boardMetrics.frameCount,
        frames.length,
        `${path}: boardMetrics.frameCount ${manifest.boardMetrics.frameCount} != ${frames.length} frames`,
      );
    }
  }
});

test('the dataset ids the prebuilt page offers match the directories present', () => {
  const html = readFileSync(join(packageRoot, 'index.html'), 'utf8');
  const offered = [...new Set([...html.matchAll(/data-dataset="([^"]+)"/g)].map((match) => match[1]))].sort();
  assert.ok(offered.length > 0, 'index.html offers no data-dataset ids');

  const calibrationDirs = readdirSync(join(demoRoot, 'calibration'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const validationDirs = readdirSync(join(demoRoot, 'validation'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(offered, calibrationDirs, `page offers [${offered}] but demo/calibration has [${calibrationDirs}]`);
  assert.deepEqual(offered, validationDirs, `page offers [${offered}] but demo/validation has [${validationDirs}]`);
  for (const id of offered) {
    assert.ok(existsSync(join(demoRoot, 'calibration', id, 'manifest.json')), `demo/calibration/${id} has no manifest.json`);
    assert.ok(existsSync(join(demoRoot, 'validation', id, 'bin', 'manifest.json')), `demo/validation/${id}/bin has no manifest.json`);
  }
});
