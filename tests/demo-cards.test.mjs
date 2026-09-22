// Every dataset card the page offers must be scannable from the packaged demo.
//
// The defect this guards against: the markup listed scenes whose frames were
// never shipped, so the card looked selectable and then failed at runtime (or
// the reverse — the data was shipped but the card was pruned, leaving the
// visitor with a single dataset). Both halves have happened, so the check reads
// the generated page and the packaged manifests together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = join(root, 'demo');

/** Card ids per split, in the order the page offers them. */
function offeredCards() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const read = (attribute) =>
    [...html.matchAll(new RegExp(`${attribute}="([a-z0-9-]+)"`, 'g'))].map((match) => match[1]);
  const calibration = [...new Set(read('data-dataset'))];
  const validation = [...new Set(read('data-validation-dataset'))];
  return { calibration, validation };
}

test('the page offers every scene the demo ships, and no others', () => {
  const { calibration, validation } = offeredCards();
  assert.deepEqual(calibration, ['charuco-moving-board', 'charuco-fixed-board']);
  assert.deepEqual(validation, ['bin', 'bottles', 'bridge', 'rail', 'plush']);
  for (const rig of calibration) {
    assert.ok(existsSync(join(demo, 'validation', rig, 'bin', 'manifest.json')), `${rig} has no bin scene`);
  }
});

test('every calibration card resolves to frames, preview and manifest', () => {
  for (const rig of offeredCards().calibration) {
    const dir = join(demo, 'calibration', rig);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.calibration.length > 0, `${rig} lists no calibration frames`);
    for (const frame of manifest.calibration) {
      assert.ok(existsSync(join(dir, frame.file)), `${rig}: missing ${frame.file}`);
    }
    assert.ok(existsSync(join(dir, 'preview.webp')), `${rig}: missing preview.webp`);
  }
});

test('every validation card resolves to frames, preview, truth and manifest', () => {
  for (const rig of offeredCards().calibration) {
    for (const scene of offeredCards().validation) {
      const dir = join(demo, 'validation', rig, scene);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      assert.ok(manifest.validation.length > 0, `${rig}/${scene} lists no validation lines`);
      // A shared volume replaces the per-frame ones; either way the manifest may
      // only promise files that travelled with the demo.
      if (manifest.validationTruth) {
        assert.ok(existsSync(join(dir, manifest.validationTruth)), `${rig}/${scene}: missing shared truth`);
      }
      for (const frame of manifest.validation) {
        assert.ok(existsSync(join(dir, frame.file)), `${rig}/${scene}: missing ${frame.file}`);
        if (frame.truth) {
          assert.ok(existsSync(join(dir, frame.truth)), `${rig}/${scene}: missing ${frame.truth}`);
        } else {
          assert.ok(manifest.validationTruth, `${rig}/${scene}: ${frame.file} has no truth at all`);
        }
      }
      assert.ok(existsSync(join(dir, 'preview.webp')), `${rig}/${scene}: missing preview.webp`);
    }
  }
});

test('the cards state the number of lines the demo actually carries', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const counts = new Map(
    [...html.matchAll(/data-(?:validation-)?dataset="([a-z0-9-]+)"[\s\S]{0,600}?<small>(\d+) /g)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  for (const rig of offeredCards().calibration) {
    const manifest = JSON.parse(
      readFileSync(join(demo, 'calibration', rig, 'manifest.json'), 'utf8'),
    );
    assert.equal(
      counts.get(rig),
      manifest.calibration.length,
      `${rig} card claims the wrong pose count`,
    );
  }
  for (const scene of offeredCards().validation) {
    const dir = join(demo, 'validation', 'charuco-moving-board', scene);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.equal(counts.get(scene), manifest.validation.length, `${scene} card claims the wrong line count`);
  }
});
