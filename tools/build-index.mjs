#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * build-index.mjs — produce the prebuilt, self-contained English index.html
 * for the standalone laser-line-scan package.
 *
 * The website renders its laser page from content/laser-copy.json plus
 * tools/laser/page.html. This script reproduces that fill-in for English only,
 * then rewrites the asset roots for the standalone tree (`runtime/` for code
 * and styles, `demo/` for the small rendered dataset), drops the dataset ZIP
 * download links (the demo does not ship those archives) and corrects the
 * static frame counts to the demo manifests.
 *
 * `index.html` is committed, so a cloned copy needs no build step; run this
 * script from the upstream website checkout when the copy or template changes.
 *
 *   node tools/build-index.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

const calibrationIds = ['charuco-moving-board', 'charuco-fixed-board'];
// The demo ships the `bin` validation scene only, so the markup offers only the
// choices whose frames and preview actually exist in this repository.
const sceneIds = ['bin'];
const cards = (split) => (split === 'calibration' ? calibrationIds : sceneIds).map((id, n) => {
  const calibration = split === 'calibration';
  const path = calibration ? `demo/calibration/${id}` : `demo/validation/charuco-moving-board/${id}`;
  const title = strings[`${id}Name`];
  const description = calibration
    ? strings[id === 'charuco-fixed-board' ? 'fixedReference' : 'movingReference']
    : strings[`${id}Object`];
  return `<button class="ll-dataset${n ? '' : ' is-selected'}" ${calibration ? 'data-dataset' : 'data-validation-dataset'}="${id}" aria-pressed="${!n}" type="button"><div class="ll-card-image"><img src="${path}/preview.webp" width="1920" height="1080" alt="${escape(description)}" loading="lazy"><span>0${n + 1}</span></div><div class="ll-card-copy"><strong>${escape(title)}</strong><span>${escape(description)}</span><small>${calibration ? '50' : '192'} ${escape(strings[`${split}Frames`])}</small></div><span class="ll-card-check" aria-hidden="true">✓</span></button>`;
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
  .replaceAll('__PORTFOLIO__', '#')
  .replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!strings[key]) throw new Error(`Unknown token ${key}`);
    return escape(strings[key]);
  })
  .replace('__COPY_JSON__', JSON.stringify(strings).replaceAll('<', '\\u003c'));

// The demo ships no dataset ZIP archives, so the download rows are removed from
// the static markup; the runtime guards the matching DOM lookups.
fragment = fragment.replace(/<div class="ll-downloads">.*?<\/div>/g, '');
// Card previews and frame images resolve against the packaged demo directory.

// Static frame counts must match the demo manifests: 12 calibration poses and
// 12 validation lines. The runtime overwrites most of these once a manifest is
// loaded; the initial document still has to be honest before that happens.
const counts = [
  ['id="ll-frame-badge">001 / 50<', 'id="ll-frame-badge">001 / 12<'],
  ['id="ll-frame" type="range" min="0" max="49"', 'id="ll-frame" type="range" min="0" max="11"'],
  ['id="ll-frame-output" for="ll-frame">001 / 50<', 'id="ll-frame-output" for="ll-frame">001 / 12<'],
  ['id="ll-count">0 / 50<', 'id="ll-count">0 / 12<'],
  ['id="ll-progress" value="0" max="50"', 'id="ll-progress" value="0" max="12"'],
  ['id="ll-calibrated-count">50<', 'id="ll-calibrated-count">12<'],
  ['id="ll-v-frame-badge">001 / 192<', 'id="ll-v-frame-badge">001 / 12<'],
  ['id="ll-v-frame" type="range" min="0" max="191"', 'id="ll-v-frame" type="range" min="0" max="11"'],
  ['id="ll-v-frame-output" for="ll-v-frame">001 / 192<', 'id="ll-v-frame-output" for="ll-v-frame">001 / 12<'],
  ['id="ll-line-count">192<', 'id="ll-line-count">12<'],
  ['id="ll-lines">192<', 'id="ll-lines">12<'],
  ['id="ll-v-progress" value="0" max="192"', 'id="ll-v-progress" value="0" max="12"'],
  ['<small>50 ', '<small>12 '],
  ['<small>192 ', '<small>12 '],
];
for (const [from, to] of counts) {
  if (!fragment.includes(from)) throw new Error(`Expected markup not found: ${from}`);
  fragment = fragment.replaceAll(from, to);
}

// The stylesheet link is hoisted into <head>; the tokens below are the same
// locked design tokens the website emits (assembly/design/tokens.ts).
fragment = fragment.replace('<link rel="stylesheet" href="runtime/lab.css">\n', '');
const tokens = `:root{
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

writeFileSync(join(packageRoot, 'index.html'), html);
console.log(`Wrote index.html (${html.length} bytes)`);
