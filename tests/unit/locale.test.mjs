// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Locale number formatting and the translated calibration Markdown report
 * (locale.js + calibration-report.js).
 * Ported from the parent repository's tests/laser-locale.test.mjs.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localeFormats} from '../../runtime/locale.js';
import {calibrationMarkdown} from '../../runtime/calibration-report.js';

test('scan numbers follow the selected language, including decimal and percent spacing',()=>{
 assert.equal(localeFormats('en').number(94200),'94,200');
 assert.equal(localeFormats('de').number(94200),'94.200');
 assert.equal(localeFormats('de').number(.112,3),'0,112');
 assert.equal(localeFormats('fr').number(94200),'94\u202f200');
 assert.equal(localeFormats('no').number(94200),'94\u00a0200');
 assert.equal(localeFormats('de').percent(.894),'89,4\u00a0%');
 assert.equal(localeFormats('ja').percent(.894),'89.4%');
 assert.equal(localeFormats('pt').locale,'pt-PT');
 assert.equal(localeFormats('no').locale,'nb-NO');
});

test('translated Markdown localizes metrics and headings without changing model data',()=>{
 const data={dataset:'charuco-moving-board',version:'test',completedAt:'2026-09-17T12:00:00Z',
  camera:{width:1920,height:1080,unitMm:100,fx:1665,fy:1665,cx:960,cy:540},
  fit:[0,0,0,.00112,12000,12500],calibrationFrames:50,
  boardMetrics:{reprojectionRmse:.072,minSpan:.894,minCorners:35},
  config:{cornerRefinement:'subpixel',estimator:0,threshold:40},
  planeFits:{fixed:[.02,-.45,-1.845,.00112,12000]}};
 const manifest={board:{squares:[6,8],dictionary:'DICT_4X4_50'}};
 const labels={reportCommand:'Laserbefehl',reportInliers:'Verwendete Punkte'};
 const before=JSON.stringify(data),report=calibrationMarkdown(data,manifest,k=>labels[k]||k,'de');
 assert.ok(report.includes('0,112 mm'));
 assert.ok(report.includes('89,4\u00a0%'));
 assert.ok(report.includes('12.000 / 12.500'));
 assert.ok(report.includes('| Laserbefehl | nx | nz | d (mm) | RMS (mm) | Verwendete Punkte |'));
 assert.ok(report.includes('| fixed | 0.0200000 | -0.4500000 | -184.50000 |'));
 assert.equal(JSON.stringify(data),before);
});
