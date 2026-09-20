// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Static integrity checks for the prebuilt standalone package: every manifest
 * must only promise files that exist, and index.html must only reference assets
 * that are shipped. These run under `node --test` without a browser.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = join(packageRoot, 'demo');

function manifestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...manifestFiles(path));
    else if (entry.name === 'manifest.json') found.push(path);
  }
  return found;
}

test('every demo manifest promises only files that exist', () => {
  const manifests = manifestFiles(demoRoot);
  assert.ok(manifests.length >= 4, `expected demo manifests, found ${manifests.length}`);
  for (const path of manifests) {
    const dir = dirname(path);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const split = manifest.calibration ? 'calibration' : 'validation';
    const frames = manifest[split];
    assert.ok(Array.isArray(frames) && frames.length > 0, `${path}: empty frame list`);
    for (const frame of frames) {
      assert.ok(existsSync(join(dir, frame.file)), `${path}: missing frame ${frame.file}`);
      if (frame.truth) assert.ok(existsSync(join(dir, frame.truth)), `${path}: missing truth ${frame.truth}`);
    }
    if (manifest.validationTruth) assert.ok(existsSync(join(dir, manifest.validationTruth)), `${path}: missing shared truth ${manifest.validationTruth}`);
    if (split === 'validation') assert.equal(manifest.lineCount, frames.length, `${path}: lineCount`);
    assert.equal(manifest.download, undefined, `${path}: promises a dataset ZIP that is not shipped`);
  }
});

test('index.html references only shipped assets and the demo frame counts', () => {
  const html = readFileSync(join(packageRoot, 'index.html'), 'utf8');
  const referenced = new Set();
  for (const match of html.matchAll(/src="([^"]+)"/g)) {
    const value = match[1];
    if (/^(#|https?:|data:)/.test(value)) continue;
    referenced.add(value);
  }
  assert.ok(referenced.size > 0, 'no local assets referenced');
  for (const value of referenced) {
    if (extname(value) === '') continue;
    assert.ok(existsSync(join(packageRoot, value)), `index.html references missing asset ${value}`);
  }
  // The prebuilt document must not point back at the website's multi-gigabyte
  // capture tree, and its static counts must be the 12-frame demo default.
  assert.ok(/<img[^>]*id="ll-frame-image"[^>]*src="demo\//.test(html), 'frame images resolve to the packaged demo, not a deferred marker');
  assert.ok(html.includes('id="ll-frame-badge">001 / 12<'), 'static calibration badge is not 12');
  assert.ok(html.includes('id="ll-v-frame-badge">001 / 12<'), 'static validation badge is not 12');
  assert.ok(!html.includes('ll-download'), 'index.html still offers dataset ZIP downloads');
});

test('the runtime ships the kernel and the offline runtime modules', () => {
  for (const file of ['runtime/core.wasm', 'runtime/app.js', 'runtime/worker.js', 'runtime/lab.css', 'runtime/vendor/opencv.js']) {
    assert.ok(existsSync(join(packageRoot, file)), `missing ${file}`);
  }
  assert.ok(readFileSync(join(packageRoot, 'runtime/core.wasm')).length > 0, 'core.wasm is empty');
});
