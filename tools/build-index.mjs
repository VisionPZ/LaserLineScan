#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * build-index.mjs — produce the prebuilt, self-contained English index.html
 * for the standalone laser-line-scan package.
 *
 * The website renders its laser page from content/laser-copy.json plus
 * tools/laser/page.html. This script reproduces that fill-in for English only,
 * then rewrites the asset roots for the standalone tree (`runtime/` for code
 * and styles, `demo/` for the rendered dataset), drops the dataset ZIP download
 * links (no build ships those archives) and sets the static frame counts from
 * the manifests of whichever dataset tree this run is pointed at — so the
 * deployed copy can state the whole capture sequence while the package states
 * its own small subset, without a constant in either.
 *
 * `index.html` is committed, so a cloned copy needs no build step; run this
 * script from the upstream website checkout when the copy or template changes.
 *
 *   node tools/build-index.mjs
 *   DEMO_OUT=/path/to/index.html DEMO_COUNTS_DIR=/path/to/hd node tools/build-index.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(here, '../../..');
const copy = JSON.parse(readFileSync(join(repoRoot, 'content/laser-copy.json'), 'utf8'));
const template = readFileSync(join(repoRoot, 'tools/laser/page.html'), 'utf8');

const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// The generated content stores each string's translations in a fixed order;
// English is first (see tools/laser/build-page.mjs).
const strings = Object.fromEntries(Object.entries(copy).map(([key, values]) => [key, values[0]]));
Object.assign(strings, {
  headline: 'Can you trust the visual data behind your 3D measurements?',
  lead: 'Explore how optics, calibration and stripe detection affect a reconstructed point cloud. The included captures are synthetic.',
  coverage: 'Scored-column coverage',
  metricsHelp: 'Shape error compares the reconstructed points with reference depth from synthetic captures. Scored-column coverage counts expected columns with reference-comparable measurements, not surface area.',
});

const calibrationIds = ['charuco-moving-board', 'charuco-fixed-board'];
// Every scene the demo ships gets a card: its frames and preview exist in this
// repository (see tools/make-demo-dataset.mjs), and the line count below is the
// number the demo actually carries, not the size of the full capture tree.
const sceneIds = ['bin', 'bottles', 'bridge', 'rail', 'plush'];
// Counts come from the manifests, never from constants: the package states its
// own small subset, the deployed copy states the whole capture sequence.
const countsRoot = process.env.DEMO_COUNTS_DIR ? resolve(process.env.DEMO_COUNTS_DIR) : join(packageRoot, 'demo');
const readCount = (file, key) => {
  const path = join(countsRoot, file);
  if (!existsSync(path)) throw new Error(`missing manifest for the page counts: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'))[key].length;
};
const demoFrames = {
  calibration: Object.fromEntries(calibrationIds.map((rig) => [rig,
    readCount(`calibration/${rig}/manifest.json`, 'calibration')])),
  validation: Object.fromEntries(calibrationIds.map((rig) => [rig,
    Object.fromEntries(sceneIds.map((scene) => [scene,
      readCount(`validation/${rig}/${scene}/manifest.json`, 'validation')]))])),
};
const cards = (split) => (split === 'calibration' ? calibrationIds : sceneIds).map((id, n) => {
  const calibration = split === 'calibration';
  const path = calibration ? `demo/calibration/${id}` : `demo/validation/charuco-moving-board/${id}`;
  const title = strings[`${id}Name`];
  const description = calibration
    ? strings[id === 'charuco-fixed-board' ? 'fixedReference' : 'movingReference']
    : strings[`${id}Object`];
  const count = calibration ? demoFrames.calibration[id] : demoFrames.validation['charuco-moving-board'][id];
  // The fixed-rig demo has 40 bin frames but 24 frames for other scenes. Keep
  // each rig's actual count on the card so switching rigs preserves that distinction.
  const countAttributes = calibration ? '' : calibrationIds
    .map((rig) => ` data-count-${rig}="${demoFrames.validation[rig][id]}"`).join('');
  return `<button class="ll-dataset${n ? '' : ' is-selected'}" ${calibration ? 'data-dataset' : 'data-validation-dataset'}="${id}"${countAttributes} aria-pressed="${!n}" type="button"><div class="ll-card-image"><img src="${path}/preview.webp" width="1920" height="1080" alt="${escape(description)}" loading="lazy"><span>0${n + 1}</span></div><div class="ll-card-copy"><strong>${escape(title)}</strong><span>${escape(description)}</span><small>${escape(String(count))} ${escape(strings[`${split}Frames`])}</small></div><span class="ll-card-check" aria-hidden="true">✓</span></button>`;
}).join('');

const imageTools = (split) => `<button type="button" data-image-action="out" title="${escape(strings.zoomOut)}" aria-label="${escape(strings.zoomOut)}">−</button><output>100%</output><button type="button" data-image-action="in" title="${escape(strings.zoomIn)}" aria-label="${escape(strings.zoomIn)}">+</button><button type="button" data-image-action="left" title="${escape(strings.rotateLeft)}" aria-label="${escape(strings.rotateLeft)}">↶</button><button type="button" data-image-action="right" title="${escape(strings.rotateRight)}" aria-label="${escape(strings.rotateRight)}">↷</button><button type="button" data-image-action="reset" title="${escape(strings.homeView)}" aria-label="${escape(strings.homeView)}">⟲</button><label class="ll-box-toggle"><input type="checkbox" data-image-action="roi" title="${escape(strings.roiOverlay)}">${escape(strings.dynamicRoi)}</label>`;

let fragment = template
  .replace('__DATASET_CARDS__', cards('calibration'))
  .replace('__VALIDATION_CARDS__', cards('validation'))
  .replace('__CALIBRATION_IMAGE_TOOLS__', imageTools('calibration'))
  .replace('__VALIDATION_IMAGE_TOOLS__', imageTools('validation'))
  .replace('__CALIBRATION_IMAGE_HELP__', `<span id="ll-calibration-image-keys" class="ll-sr">${escape(strings.imagePreviewKeys)}</span>`)
  .replace('__VALIDATION_IMAGE_HELP__', `<span id="ll-validation-image-keys" class="ll-sr">${escape(strings.imagePreviewKeys)}</span>`)
  .replace('__DOWNLOAD_LINKS__', '')
  .replaceAll('__LOCALE__', 'en')
  .replaceAll('__LASER_ASSET__hd/', 'demo/')
  .replaceAll('__LASER_ASSET__', 'runtime/')
  .replaceAll('__PORTFOLIO__', 'https://www.nidvue.com/portfolio/')
  .replaceAll('__ARTICLE__', 'https://www.nidvue.com/articles/laser-line-scan-defect-inspection/')
  .replaceAll('__SOURCE__', 'https://github.com/VisionPZ/LaserLineScan')
  .replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!strings[key]) throw new Error(`Unknown token ${key}`);
    return escape(strings[key]);
  })
  .replace('__COPY_JSON__', JSON.stringify(strings).replaceAll('<', '\\u003c'));

// Keep the standalone package's conversion path and evidence explanation when rebuilding.
const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error(`Expected exactly one page marker: ${before.slice(0, 60)}`);
  return source.replace(before, after);
};
fragment = replaceOnce(fragment, '</p></div>\n    <img class="ll-hero-mascot"', '</p><p class="ll-hero-paths"><a href="#ll-setup-heading">Explore the five-stage lab →</a><a href="https://www.nidvue.com/engagement/#project-brief">Discuss a visual measurement problem →</a></p><p class="ll-evidence-note">Browser-only reference case · Synthetic captures · No upload</p></div>\n    <img class="ll-hero-mascot"');
fragment = replaceOnce(fragment, '    <div class="ll-step-actions"><button id="ll-back-validation"', '    <aside class="ll-audit-bridge ll-panel" aria-labelledby="ll-audit-bridge-title"><p class="ll-eyebrow">NIDVUE / REFERENCE CASE</p><h3 id="ll-audit-bridge-title">What can you trust about this result?</h3><p>The error compares this reconstruction with reference depth from synthetic captures. Coverage counts expected scan columns that produced reference-comparable measurements; it is not the fraction of the object surface measured. Neither metric establishes physical scanner accuracy.</p><p>Have real inspection or perception data with uncertain calibration, missing coverage or unstable detections? Bring one concrete case and the evidence you already have. We can define a focused assessment and the measurements needed to make a decision.</p><p><a href="https://www.nidvue.com/engagement/#project-brief">Discuss a visual-data assessment →</a> <span aria-hidden="true">·</span> <a href="https://www.nidvue.com/articles/laser-line-scan-defect-inspection/">Read how the result is evaluated →</a></p></aside>\n    <div class="ll-step-actions"><button id="ll-back-validation"');

// The demo ships no dataset ZIP archives, so the download rows are removed from
// the static markup; the runtime guards the matching DOM lookups.
fragment = fragment.replace(/<div class="ll-downloads">.*?<\/div>/g, '');
// Card previews and frame images resolve against the packaged demo directory.

// The template states the capture tree's counts (50 poses, 192 lines); rewrite
// them to whatever this build actually ships. The runtime overwrites these once
// a manifest loads, but the initial document still has to be honest.
const poses = demoFrames.calibration['charuco-moving-board'];
const lines = demoFrames.validation['charuco-moving-board'].bin;
const counts = [
  ['id="ll-frame-badge">001 / 50<', `id="ll-frame-badge">001 / ${poses}<`],
  ['id="ll-frame" type="range" min="0" max="49"', `id="ll-frame" type="range" min="0" max="${poses - 1}"`],
  ['id="ll-frame-output" for="ll-frame">001 / 50<', `id="ll-frame-output" for="ll-frame">001 / ${poses}<`],
  ['id="ll-count">0 / 50<', `id="ll-count">0 / ${poses}<`],
  ['id="ll-progress" value="0" max="50"', `id="ll-progress" value="0" max="${poses}"`],
  ['id="ll-calibrated-count">50<', `id="ll-calibrated-count">${poses}<`],
  ['id="ll-v-frame-badge">001 / 192<', `id="ll-v-frame-badge">001 / ${lines}<`],
  ['id="ll-v-frame" type="range" min="0" max="191"', `id="ll-v-frame" type="range" min="0" max="${lines - 1}"`],
  ['id="ll-v-frame-output" for="ll-v-frame">001 / 192<', `id="ll-v-frame-output" for="ll-v-frame">001 / ${lines}<`],
  ['id="ll-line-count">192<', `id="ll-line-count">${lines}<`],
  ['id="ll-lines">192<', `id="ll-lines">${lines}<`],
  ['id="ll-v-progress" value="0" max="192"', `id="ll-v-progress" value="0" max="${lines}"`],
];
for (const [from, to] of counts) {
  if (!fragment.includes(from)) throw new Error(`Expected markup not found: ${from}`);
  fragment = fragment.replaceAll(from, to);
}
// The cards carry the demo's own line counts, so they are asserted rather than
// patched: every count comes from the packaged manifests.
for (const [id, lines] of [...calibrationIds.map((rig) => [rig, demoFrames.calibration[rig]]), ...sceneIds.map((s) => [s, demoFrames.validation['charuco-moving-board'][s]])]) {
  const want = `<small>${String(lines)} `;
  if (!fragment.includes(want)) throw new Error(`Card line count missing for ${id}: ${want}`);
}

// The stylesheet link is hoisted into <head>; the tokens below are the same
// locked design tokens the website emits (assembly/design/tokens.ts).
fragment = fragment.replace('<link rel="stylesheet" href="runtime/lab.css">\n', '');
const tokens = `.ll-hero-paths{display:flex;flex-wrap:wrap;gap:10px 22px;margin:16px 0 4px}.ll-hero-paths a,.ll-audit-bridge a{color:var(--accent);font-weight:600;text-underline-offset:3px}.ll-evidence-note{font-size:.86rem;color:var(--muted)}.ll-audit-bridge{margin:24px 0;padding:24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}.ll-audit-bridge h3{font-size:1.2rem}.ll-audit-bridge p{max-width:80ch}
:root{
  --brand:#5857E8; --brand-deep:#3837A8; --brand-soft:#A09FFF;
  --fog:#E8EAF2; --stone:#C8BFB2; --bearing:#00A98F;
  --mint:#00A98F; --warn:#D9A400; --fail:#D64545;
  --radius:20px; --radius-btn:10px; --radius-media:12px;
  --reading-width:68ch;
  --sans:Inter,"Noto Sans SC",system-ui,-apple-system,"Segoe UI",Arial,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;
}
:root,[data-theme=dark]{
  --bg:#0A0E1D; --ink:#F5F6FF; --muted:#B3BAD0; --line:#28314A;
  --surface:#141A2D; --surface-solid:#141A2D; --tint:#171D38;
  --accent:var(--brand-soft); --shadow:0 24px 65px rgba(0,0,0,.34);
}
[data-theme=light]{
  --bg:#F7F8FC; --ink:#0E1324; --muted:#626A82; --line:#E3E6F0;
  --surface:#FFFFFF; --surface-solid:#FFFFFF; --tint:#EDEEFF;
  --accent:var(--brand); --shadow:0 20px 55px rgba(17,23,54,.1);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased}
.wrap{max-width:1200px;margin:0 auto;padding:0 64px}
@media(max-width:900px){.wrap{padding:0 32px}}
@media(max-width:600px){.wrap{padding:0 20px}}
h1,h2,h3{margin:0;font-weight:600}
.skip-link{position:fixed;left:18px;top:12px;z-index:1000;padding:12px;border-radius:10px;background:var(--brand);color:#fff;font-weight:600;transform:translateY(-150%);transition:transform .2s}
.skip-link:focus{transform:none}
`;

const html = `<!--
  SPDX-License-Identifier: GPL-3.0-or-later
-->
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/svg+xml" href="runtime/mascots/nidvue-84-scan.svg">
<title>laser-line-scan · ${escape(strings.title)}</title>
<meta name="description" content="${escape(strings.lead)}">
<!-- The project's one address: the apex host serves the same bytes, so it
     canonicalises here rather than competing with it. -->
<link rel="canonical" href="https://www.nidvue.com/laser-line-scan/">
<style>${tokens}</style>
<link rel="stylesheet" href="runtime/lab.css">
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<main id="main" class="wrap">
${fragment}</main>
</body>
</html>
`;

const outPath = process.env.DEMO_OUT ? resolve(process.env.DEMO_OUT) : join(packageRoot, 'index.html');
writeFileSync(outPath, html);
console.log(`Wrote ${outPath} (${html.length} bytes)`);
