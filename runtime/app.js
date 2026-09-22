// SPDX-License-Identifier: GPL-3.0-or-later
import {calibrationMarkdown,calibrationPowerpoint} from './calibration-report.js';
import {searchBand,bandCoverage} from './stripe-roi.js';
import {spectralModel,transformSpec,applySpectral,transmissionAt,controlPointsFor,AMBIENT_PRESETS,LASER_PRESETS,FILTER_PRESETS,SENSOR_PRESETS,LAMBDA_MIN,LAMBDA_MAX} from './spectral.js';
import {applySpectralFrame} from './spectral-gl.js';
import {SpectrumPlot,sampleAt} from './spectral-plot.js';
import {ScanViewer} from './viewer.js';
import {buildRigScene} from './rig-scene.js';
import {ImagePreview} from './image-preview.js';
import {localeFormats} from './locale.js';
const root=document.querySelector('#laser-lab'),$=id=>root.querySelector('#ll-'+id),copy=JSON.parse($('copy').textContent),form=$('form'),fields=$('fields'),base=new URL('../',import.meta.url);
const text=key=>copy[key]||key,field=name=>form.elements.namedItem(name),prefix=split=>split==='validation'?'v-':'';
const formats=localeFormats(root.dataset.locale);
const datasets={calibration:'charuco-moving-board',validation:'bin'},manifests={calibration:null,validation:null},versions={calibration:0,validation:0},playing={},previewBlobs={},scanned={calibration:false,validation:false};
let calibration=null,result=null,worker=null,busy=null,viewer,rigViewer,step=0,exporting=false;
// The spectral design drives the rendering of steps 1-3 and the scan worker.
// `spectralDesign` is rebuilt whenever the step-0 controls change.
const spectralSeries={laser:true,detected:true,filter:true,ambient:true,qe:true};
// Hand-placed control points per series; null means the model curve is used.
const curveOverrides={laser:null,filter:null,ambient:null,qe:null};
const CURVE_CONTROLS={laser:['laser-preset','laser-fwhm','laser-modes'],filter:['filter-preset','filter-fwhm','filter-peak','filter-od'],qe:['sensor-preset'],ambient:['ambient-preset','ambient-level']};
let spectralDesign=spectralModel(),spectrumPlot=null,curveMenu={series:null,index:-1},heavyPending=null;
const imagePreviews=Object.fromEntries(['calibration','validation'].map(split=>[split,new ImagePreview($(split+'-scan'))]));
// The last frame the calibration worker annotated. The end-of-run ROI pass must
// re-apply it rather than replace it: the two are otherwise ordered by timing, and
// a stale corner overlay would then sit on the final frame (the published figure's
// off-by-one frame).
let lastCalibrationCorners=null;
// ?mono=1 loads the object scan from the single-channel dataset. The calibration
// board stays on the colour path, and the worker detects the mono manifest from
// its `channels` field.
const MONO=new URLSearchParams(location.search).get('mono')==='1';
const datasetBase=split=>new URL(split==='calibration'?`demo/calibration/${datasets.calibration}/`:MONO?`hd-mono/validation/${datasets.calibration}/${datasets.validation}/`:`demo/validation/${datasets.calibration}/${datasets.validation}/`,base);
const status=(key,error=false,split='calibration')=>{const el=$(prefix(split)+'status'),value=text(key).replaceAll('{name}',text((manifests.validation?.calibrationId||datasets.calibration)+'Name'));if(el.textContent!==value)el.textContent=value;el.parentElement.classList.toggle('is-error',error);};
const config=split=>({direction:'top-down',channel:0,cornerRefinement:field('cornerRefinement').value,distortionModel:field('distortionModel').value,estimator:+field('estimator').value,threshold:40,quantile:.98,roi:100,focal:manifests.calibration?.fx||1665,model:'fit',tilt:0,referenceScale:1,outlierMm:.5,emitterBaseline:manifests.calibration?.emitterBaselineMm||248,roiDepthMargin:.2,roiMarginPx:8,recoverMissing:window.__recoverMissing??new URLSearchParams(location.search).get('recoverMissing')!=='0',shoulderRecovery:window.__shoulderRecovery??true,spectral:spectralConfig(split)});
const compatible=()=>!!calibration&&manifests.validation?.calibrationId===calibration.dataset&&manifests.validation?.rigId===calibration.rigId;
function state(){
 root.classList.toggle('is-running',!!busy);root.dataset.runningStage=busy||'';fields.disabled=!!busy;
 $('start').disabled=!!busy||!manifests.calibration||!viewer;$('validate').disabled=!!busy||!compatible()||!viewer;$('reset').disabled=!!busy;
 $('cancel').hidden=busy!=='calibration';$('v-cancel').hidden=busy!=='validation';
 root.querySelectorAll('[data-dataset],[data-validation-dataset]').forEach(b=>b.disabled=!!busy);
 for(const split of ['calibration','validation'])for(const id of ['frame','play'])$(prefix(split)+id).disabled=!!busy||!manifests[split];
 for(const id of ['to-validation','back-calibration'])$(id).disabled=!!busy||!calibration;
 $('to-result').disabled=!!busy||!result;$('back-validation').disabled=!!busy;
 // The illumination is fixed once a scan has been produced: changing it would
 // invalidate the displayed point cloud and its colours.
 const spectralLocked=!!busy||!!result;
 for(const el of [$('laser-preset'),$('laser-fwhm'),$('laser-modes'),$('filter-preset'),$('filter-fwhm'),$('filter-peak'),$('filter-od'),$('sensor-preset'),$('ambient-preset'),$('spectral-reset')])if(el)el.disabled=spectralLocked;
 root.querySelectorAll('.ll-stepper [data-step]').forEach(b=>{
  const n=+b.dataset.step;b.disabled=!!busy||(n>2&&!calibration)||(n===4&&!result);
  b.classList.toggle('is-complete',n===2?!!calibration:n===3?!!result:false);
  if(n===step)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');
 });
 $('compatibility').textContent=calibration?'✓ '+text('calibrationSuccess')+' · '+text(calibration.dataset+'Name')+' · '+formats.number(calibration.fit[3]*calibration.camera.unitMm,3)+' mm':text('validationWait');
 for(const id of ['calibration-markdown','calibration-powerpoint','calibration-report'])$(id).disabled=!!busy||!calibration||exporting;
 $('start').classList.toggle('ll-secondary',!!calibration);$('start').classList.toggle('ll-primary',!calibration);
}
function goStep(n,focus=true){
 if(busy||(n>2&&!calibration)||(n===4&&!result))return;
 if(n>2)$('calibration-results').classList.remove('is-guided');
 for(const s of ['calibration','validation'])stopPlay(s);
 step=n;root.dataset.step=String(n);
 root.querySelectorAll('[data-panel]').forEach(p=>{p.hidden=+p.dataset.panel!==n;p.classList.toggle('is-entering',+p.dataset.panel===n);});
 viewer?.setActive(n===4);rigViewer?.setActive(n===1);if(n!==4)stopOrbit();state();
 // Reaching the scan step must leave something to scan: if the selected
 // dataset's manifest has not been fetched yet, fetch it now rather than
 // leaving the Scan button disabled until a card happens to be clicked.
 if(n===3&&!manifests.validation)select('validation',datasets.validation);
 if(focus)requestAnimationFrame(()=>{root.querySelector('.ll-stepper').scrollIntoView({block:'start',behavior:'instant'});$(n===0?'setup-heading':n===1?'rig-heading':n===2?'dataset-heading':n===3?'validation-heading':'result-heading').focus({preventScroll:true});viewer?.draw();});
}
// Metric values are graded against the documented design targets, so a glance
// says whether a number is fine, marginal or wrong. Informational values (counts,
// geometry, lens model) stay neutral — colour here means attention.
function gradeMetric(id,level){const el=$(id);if(!el)return;el.classList.remove('is-ok','is-warn','is-crit');if(level)el.classList.add(level);}
function gradeSpectral(model,cornerAtField){
 // Step 00: the laser must survive the filter, the filter must reject the room,
 // and the stripe must stand out of it.
 gradeMetric('s-laser',model.laserTransmission>=.9?'is-ok':model.laserTransmission>=.7?'is-warn':'is-crit');
 gradeMetric('s-ambient',model.ambientTransmission<=.15?'is-ok':model.ambientTransmission<=.3?'is-warn':'is-crit');
 gradeMetric('s-contrast',model.contrastGain>=5?'is-ok':model.contrastGain>=3?'is-warn':'is-crit');
 // Grade the value on screen (the field-corner transmission), not the extreme angle.
 gradeMetric('s-corner',cornerAtField>=.4?'is-ok':cornerAtField>=.25?'is-warn':'is-crit');
}
function clearValidation(){result=null;viewer?.clear();$('empty').hidden=false;$('ply').disabled=true;for(const id of ['points','rmse','coverage','verified','out-of-band','recovered']){$(id).textContent='—';$(id).removeAttribute('title');}for(const id of ['points','rmse','coverage','verified','out-of-band','recovered'])$(id).classList.remove('is-ok','is-warn','is-crit');for(const id of ['points-sub','rmse-sub','coverage-sub','lines-sub','verified-sub','out-of-band-sub','recovered-sub','verdict-title','verdict-sub'])$(id).textContent='';$('verdict').hidden=true;delete $('verdict').dataset.tier;$('verdict-advice').hidden=true;$('verdict-advice').textContent='';$('v-progress').value=0;syncCount('validation');$('object').textContent=text('measured');status('validationWait',false,'validation');}
function clearCalibration(){calibration=null;clearValidation();$('export-status').textContent='';$('calibration-results').hidden=true;$('calibration-results').classList.remove('is-guided');$('calibration-report').disabled=true;for(const id of ['residual','calibrated-count','board-rmse','board-span','board-corners','baseline','distortion','roi'])$(id).textContent='—';for(const id of ['residual','board-rmse','board-span','board-corners'])gradeMetric(id,null);$('roi-help').textContent='';$('lens-model').textContent='';$('parameters').textContent='—';$('progress').value=0;syncCount('calibration');}
function stopPlay(split){clearInterval(playing[split]);playing[split]=null;const el=$(prefix(split)+'play');el.textContent='▶';el.setAttribute('aria-label',text('play'));}
// Frame counts come from the loaded manifest, never from the template, so a
// split whose manifest declares a different number of frames cannot leave a
// stale total on screen. The run's own progress messages own the readout while
// a job is busy.
function syncCount(split){
 if(busy)return;
 const el=$(prefix(split)+'count');if(!el)return;
 const list=frames(split);el.textContent=list.length?`0 / ${list.length}`:'';
 const total=manifests.validation?.lineCount||list.length;
 const tag=$('line-count');
 if(split==='validation'&&tag&&total)tag.textContent=String(total);
}
// Calibration-derived search band for a frame, built by the same function the
// worker scans with (full band config: depth prior, band mode, margins, the
// object-column bound), so stepping through calibration or validation frames
// outlines the rows the kernel actually scored.
function frameRoi(split,frame){
 if(!calibration||!frame)return null;
 const manifest=manifests[split];if(!manifest)return null;
 // The worker merges the scan's config over the calibration's own, so the
 // outline follows the same merge.
 const bandConfig=split==='validation'?{...calibration.config,...config(split)}:calibration.config;
 try{return searchBand(calibration,manifest,frame,bandConfig||{});}catch{return null;}
}
// Mean fraction of image rows the ROI leaves to search across a split's frames.
function roiCoverage(split){
 if(!calibration?.stripeRoi)return null;
 const manifest=manifests[split],list=manifest?.[split];if(!manifest||!list?.length)return null;
 let sum=0,count=0;
 try{
  for(const frame of list){const band=frameRoi(split,frame);if(!band)continue;sum+=bandCoverage(band,manifest.height);count++;}
 }catch{return null;}
 return count?sum/count:null;
}
function frames(split){return manifests[split]?.[split]||[];}
async function showFrame(split,index,override=null,blob=null,annotation=null){
 const m=manifests[split];if(!m)return;const p=prefix(split),seq=frames(split);index=Math.max(0,Math.min(seq.length-1,index));const frame=override||seq[index];
 $(p+'frame').max=seq.length-1;$(p+'frame').value=index;
 const img=$(p+'frame-image'),oldBlob=previewBlobs[split];delete img.dataset.processingFrame;previewBlobs[split]=blob?URL.createObjectURL(blob):null;
 img.src=previewBlobs[split]||new URL(frame.file,datasetBase(split)).href;img.alt=text(split)+' · '+text(datasets[split]+'Name')+' · '+text('frame')+' '+(index+1);
 const count=String(index+1).padStart(3,'0')+' / '+seq.length;$(p+'frame-output').textContent=count;$(p+'frame-badge').textContent=count;
 try{await img.decode();}catch{if(override)throw new Error('imageFailed');return;}finally{if(oldBlob)URL.revokeObjectURL(oldBlob);}
 await queueSpectralFrame(split);
 const roi=(annotation||override)?null:frameRoi(split,frame);
 imagePreviews[split].annotate(annotation||(roi?{roi}:null));
}
async function select(split,id,force=false){
 // Re-selecting the dataset that is already loaded must not discard a completed
 // calibration (or a scan result). The Reset button and the initial load force
 // a reload.
 if(!force&&datasets[split]===id&&manifests[split])return;
 imagePreviews[split].reset();
 stopPlay(split);const version=++versions[split];manifests[split]=null;datasets[split]=id;scanned[split]=false;
 if(split==='calibration'){clearCalibration();manifests.validation=null;++versions.validation;}else clearValidation();state();status('loading',false,split);
 const attr=split==='calibration'?'dataset':'validationDataset',selector=split==='calibration'?'[data-dataset]':'[data-validation-dataset]';
 root.querySelectorAll(selector).forEach(b=>{const selected=b.dataset[attr]===id;b.classList.toggle('is-selected',selected);b.setAttribute('aria-pressed',String(selected));});
 try{
  const url=new URL('manifest.json',datasetBase(split)),response=await fetch(url);if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const data=await response.json();if(version!==versions[split])return;manifests[split]=data;syncCount(split);
  if(split==='calibration')setRigGeometry(data);
  if(split==='calibration')updateRig(data);
  if(split==='calibration'){
   form.reset();
   root.querySelectorAll('[data-validation-dataset]').forEach(b=>{b.querySelector('img').src=new URL(`demo/validation/${id}/${b.dataset.validationDataset}/preview.webp`,base).href;});
  }else{
   $('validation-object').textContent=text(id+'Object');
   // The smaller standalone datasets have different counts per scene.
   const frames=text('validationFrames');
   root.querySelectorAll('[data-validation-dataset] small').forEach(el=>{const count=el.closest('[data-validation-dataset]').getAttribute('data-count-'+datasets.calibration)||String(data.validation.length);el.textContent=`${count} ${frames}`;});
  }
  // The capture archives are not published with this build, so the download
  // affordance is optional: fill it in only when the page offers it and the
  // manifest names an archive. Writing to a missing element threw here, aborting
  // the rest of this function — which is why the frame, the counts and the
  // status stayed empty on every visit to step 02 and 03.
  const p=prefix(split),link=$(p+'download');
  if(link&&data.download)link.href=new URL(data.download,url).href;
  await showFrame(split,0);if(version!==versions[split])return;
  status(split==='calibration'?'ready':compatible()?'validationReady':'validationWait',false,split);state();
  if(split==='calibration')await select('validation',datasets.validation);
 }catch(error){if(version===versions[split]){status(error.message,true,split);state();}}
}
// The rig draws the laser from the design, so the sheet, the beamer aperture and
// the projected line match the spectrum panel above them and the frames in
// steps 1-3. The filter glass takes the colour it transmits, lifted so it reads
// against the dark scene.
const rigNumber=(id,fallback)=>{const el=$(id);const value=el?Number(el.value):NaN;return Number.isFinite(value)&&value>0?value:fallback;};
const rigDesign=()=>({laserColor:spectralDesign.stripeColor,stripeColor:spectralDesign.stripeColor,filterColor:spectralDesign.stripeColor.map(v=>v*.55+.45),filterEnabled:spectralDesign.params.filterEnabled,ambientLevel:spectralDesign.ambientLevel*(spectralDesign.ambientYield??1),ambientTint:spectralDesign.ambientTint,baseline:rigNumber('rig-baseline',248),distance:rigNumber('rig-distance',388)});
// The rig geometry sliders are the physical head parameters; the tilt, the board
// position and both dimension rulers are derived from them by buildRigScene.
function setRigGeometry(manifest){
 const baseline=Number(manifest?.emitterBaselineMm)||248, distance=Number(manifest?.objectDistanceMm)||388;
 if($('rig-baseline'))$('rig-baseline').value=String(Math.round(baseline));
 if($('rig-distance'))$('rig-distance').value=String(Math.round(distance));
}
function updateRig(manifest,keepView=false){const design=rigDesign(),rig=buildRigScene(manifest||{},design);rigViewer.setScene(rig.vertices,rig.opaque,rig.fan,rig.fov,{center:rig.center,radius:rig.radius,keepView});rigViewer.setDimensions(rig.dimensions.map(d=>({at:d.at,text:`${formats.number(d.value,0)} mm`,title:text(d.id==='baseline'?'rigBaseline':'rigDistance')})));if(!keepView)setRigView('iso');const c=$('rig-viewer');c.dataset.rigAngle=String(rig.angle);c.dataset.rigBaseline=String(rig.baseline);c.dataset.rigDistance=String(rig.distance);c.dataset.laserColor=design.laserColor.map(v=>v.toFixed(3)).join(',');c.dataset.fovColor=rig.fovColour.map(v=>v.toFixed(3)).join(',');const out=$('rig-tools')?.querySelector('output');if(out)out.value='100%';if($('rig-baseline-output'))$('rig-baseline-output').value=formats.number(rig.baseline,0)+' mm';if($('rig-distance-output'))$('rig-distance-output').value=formats.number(rig.distance,0)+' mm';const label=$('rig-spectral-label');if(label)label.textContent=formats.number(spectralDesign.params.center,0)+' nm';const swatch=$('rig-spectral')?.querySelector('.ll-swatch');if(swatch)swatch.style.background=`rgb(${spectralDesign.stripeColor.map(v=>Math.round(Math.min(1,Math.max(0,v))*255)).join(' ')})`;}
function save(filename,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function displayCalibration(data){
 data.completedAt=new Date().toISOString();calibration=data;const m=manifests.calibration;$('calibration-results').hidden=false;$('residual').textContent=formats.number(data.fit[3]*m.unitMm,3)+' mm';$('calibrated-count').textContent=data.calibrationFrames+' / '+m.calibration.length;
 const baseMm=data.encoderModel?Math.hypot(...data.encoderModel.emitter)*m.unitMm:Math.hypot(...m.emitterCamera)*m.unitMm;
 const planes=Object.values(data.planeFits),lines=[`${text('reportPlaneTable')}: ${planes.length}`];
 if(data.encoderModel){
  lines.push('[nx, nz] = b0 + b1 qx + b2 qy');
  for(const axis of ['nx','nz'])lines.push(`${axis}: ${data.encoderModel[axis].map(n=>n.toFixed(7)).join(', ')}`);
  lines.push(`E [X, Y, Z] (mm): ${data.encoderModel.emitter.map(n=>(n*m.unitMm).toFixed(3)).join(', ')}`);
 }else lines.push(`Y + (${planes[0][0].toFixed(6)}) X + (${planes[0][1].toFixed(6)}) Z = ${planes[0][2].toFixed(6)}`);
 if(data.stripeRoi)lines.push(`${text('roiOverlay')}: ${formats.number(data.stripeRoi[0]*m.unitMm,0)} – ${formats.number(data.stripeRoi[1]*m.unitMm,0)} mm`);
 lines.push(`${text('reportInliers')}: ${formats.number(Math.round(data.fit[4]))} / ${formats.number(Math.round(data.fit[5]))}`);lines.push(`${text('baseline')}: ${formats.number(baseMm,1)} mm`);const cam=data.camera,lensLabel=cam.model==='none'?text('distNone'):cam.model==='rational'?text('distRational'):text('distBrown');lines.push(`${text('cameraIntrinsics')}: fx ${formats.number(cam.fx,1)} · fy ${formats.number(cam.fy,1)} · cx ${formats.number(cam.cx,1)} · cy ${formats.number(cam.cy,1)}`);lines.push(`${text('distortionModel')}: ${lensLabel} · ${cam.dist.map(n=>n.toFixed(6)).join(', ')}`);$('parameters').textContent=lines.join('\n');
 $('board-rmse').textContent=formats.number(data.boardMetrics.reprojectionRmse,3)+' px';$('board-span').textContent=formats.percent(data.boardMetrics.minSpan);$('board-corners').textContent=data.boardMetrics.minCorners;
 // Step 02: the fit and the board detection are the two things that can be
 // wrong; the spans and the corner count say whether the pose is solid.
 const residualMm=data.fit[3]*m.unitMm,reprojection=data.boardMetrics.reprojectionRmse,span=data.boardMetrics.minSpan,corners=data.boardMetrics.minCorners;
 gradeMetric('residual',residualMm<=.2?'is-ok':residualMm<=.5?'is-warn':'is-crit');
 gradeMetric('board-rmse',reprojection<=.5?'is-ok':reprojection<=1.5?'is-warn':'is-crit');
 gradeMetric('board-span',span>=.8?'is-ok':span>=.6?'is-warn':'is-crit');
 gradeMetric('board-corners',corners>=30?'is-ok':corners>=20?'is-warn':'is-crit');$('baseline').textContent=formats.number(baseMm,1)+' mm';$('distortion').textContent=cam.model==='none'?'—':'k1 '+formats.number(cam.dist[0],4);$('lens-model').textContent=lensLabel;
 // Search ROI: the working depth interval the calibration determined, and the
 // mean fraction of image rows the calibration frames actually need to search.
 if(data.stripeRoi){$('roi').textContent=`${formats.number(data.stripeRoi[0]*m.unitMm,0)} – ${formats.number(data.stripeRoi[1]*m.unitMm,0)} mm`;const coverage=roiCoverage('calibration');$('roi-help').textContent=coverage===null?'':`${text('coverage')} ${formats.percent(coverage)}`;}else{$('roi').textContent='—';$('roi-help').textContent='';}
 $('corner-mode').textContent=text(data.boardMetrics.refinement?.mode==='subpixel'?'cornerSubpixel':'cornerOff');
 // The calibration measured the real head, so the rig preview and its geometry
 // sliders move to the calibrated baseline.
 if(Number.isFinite(baseMm)&&$('rig-baseline')){$('rig-baseline').value=String(Math.round(baseMm));updateRig(manifests.calibration,true);}
 // The measured intrinsics changed the preview geometry, so both splits
 // re-render: every frame the scan jobs shade uses the calibrated camera too.
 queueSpectralFrame('calibration');queueSpectralFrame('validation');
 $('calibration-report').disabled=false;status('calibrationDone');status('validationReady',false,'validation');
 // The ROI is known now: highlight it on the frame on screen, then on every
 // frame the user steps through.
 const current=frames('calibration')[+$('frame').value],roi=frameRoi('calibration',current);
 if(lastCalibrationCorners||roi)imagePreviews.calibration.annotate(lastCalibrationCorners?{...lastCalibrationCorners,roi}:{roi});
}
function displayValidation(data){
 result=data;viewer.setCloud(data,'front');viewer.orbit(true);$('orbit').setAttribute('aria-pressed','true');$('empty').hidden=true;const count=formats.number(data.metrics.points);$('points').textContent=count;$('viewer').dataset.recovered=String(data.metrics.recoveredColumns??0);
 $('rmse').textContent=data.metrics.rmse===null?'—':formats.number(data.metrics.rmse,3)+' mm';$('coverage').textContent=formats.percent(data.metrics.coverage);$('lines').textContent=manifests.validation.validation.length;
 $('verified').textContent=data.metrics.verified?text('verifiedYes'):text('verifiedNo');
 $('out-of-band').textContent=formats.percent(data.metrics.outOfBandRate||0);
 $('recovered').textContent=formats.number(data.metrics.recoveredColumns||0);
 // The verdict answers the first question on this step — how good is the
 // scan — before the cards below explain each number. Coverage tiers:
 // ≥98% complete, ≥90% good, ≥75% usable gaps, below that large gaps.
 const linesN=manifests.validation.validation.length,tier=data.metrics.coverage>=.98?'excellent':data.metrics.coverage>=.9?'good':data.metrics.coverage>=.75?'fair':'poor',cap=tier[0].toUpperCase()+tier.slice(1);
 $('points-sub').textContent=text('perScanLine').replaceAll('{n}',formats.number(Math.round(data.metrics.points/linesN)));
 $('rmse-sub').textContent=text('rmseTarget');
 $('coverage-sub').textContent=text('coverageColumns').replaceAll('{scored}',formats.number(data.metrics.scored)).replaceAll('{expected}',formats.number(data.metrics.expected));
 $('lines-sub').textContent=text('linesSub');
 $('verified-sub').textContent=text('framesChecked').replaceAll('{n}',formats.number(data.metrics.verifiedFrames||0));
 $('out-of-band-sub').textContent=`${text(data.metrics.bandMode==='fixed'?'bandFixed':'bandUncertainty')} · k=${data.metrics.bandSigmaK??3}`;
 $('recovered-sub').textContent=text('recoveredSub');
 // Only out-of-target numbers take a colour: coverage by verdict tier, shape
 // error against the 1 mm target, the verification result and the band rate.
 const rate=data.metrics.outOfBandRate||0;
 gradeMetric('coverage',tier==='excellent'||tier==='good'?'is-ok':tier==='fair'?'is-warn':'is-crit');
 gradeMetric('rmse',data.metrics.rmse===null?null:data.metrics.rmse<=1?'is-ok':data.metrics.rmse<=3?'is-warn':'is-crit');
 gradeMetric('verified',data.metrics.verified?'is-ok':'is-warn');
 gradeMetric('out-of-band',rate>=.05?'is-crit':rate>=.01?'is-warn':null);
 $('verdict').hidden=false;$('verdict').dataset.tier=tier;$('verdict-title').textContent=text('verdict'+cap);
 $('verdict-sub').textContent=text('verdict'+cap+'Help')+(data.metrics.verified?'':' · '+text('verdictUnverified'));
 $('verdict-advice').hidden=tier==='excellent'||tier==='good';$('verdict-advice').textContent=text('verdictGapAdvice');
 $('object').textContent=text(datasets.validation+'Object')+' · '+(manifests.validation?.width||'—')+' × '+(manifests.validation?.height||'—')+' · '+manifests.validation.validation.length+' '+text('scanLines');
 $('dimensions').textContent='X '+formats.number(viewer.extent[0],1)+'  ×  Y '+formats.number(viewer.extent[1],1)+'  ×  Z '+formats.number(viewer.extent[2],1)+' mm';
 $('ply').disabled=false;status('complete',false,'validation');
}
function finish(){worker?.terminate();worker=null;busy=null;state();}
async function leaveScanFullscreen(split){
 if(document.fullscreenElement===$(split+'-scan'))try{await document.exitFullscreen();}catch{/* Keep the scan controls usable if the browser refuses. */}
}
function guideCalibrationReview(){
 const completed=calibration;
 requestAnimationFrame(()=>{
  if(!completed||calibration!==completed||step!==2||busy)return;
  const results=$('calibration-results');results.classList.add('is-guided');results.focus({preventScroll:true});results.scrollIntoView({block:'start',behavior:'instant'});
 });
}
async function run(split){
 if(busy||worker||!manifests[split]||!form.reportValidity()||(split==='validation'&&!compatible()))return;
 for(const s of ['calibration','validation'])stopPlay(s);
 if(split==='calibration')clearCalibration();else clearValidation();busy=split;scanned[split]=true;state();status(split==='calibration'?'processing':'reconstructing',false,split);
 const started=performance.now();let active;
 $(prefix(split)+'count').textContent='0 / '+frames(split).length;
 try{active=worker=new Worker(new URL('worker.js',import.meta.url),{type:'module'});}catch{status('browserError',true,split);finish();return;}
 active.onerror=event=>{event.preventDefault();status(event.message||'browserError',true,split);finish();};
 active.onmessage=async({data})=>{
  if(active!==worker)return;
  if(data.type==='buffering'){const p=prefix(split);$(p+'progress').max=data.total;$(p+'progress').value=data.done;$(p+'count').textContent=`${data.done} / ${data.total}`;status('buffering',false,split);return;}
  if(data.type==='progress'){
   const p=prefix(split);$(p+'progress').max=data.total;$(p+'progress').value=data.done;$(p+'count').textContent=`${data.done} / ${data.total}`;status(data.stage==='fit'?'fitting':split==='calibration'?'processing':'reconstructing',false,split);
   if(data.file){try{
    const displayStarted=performance.now();
    const view=data.extra?.view,roi=data.extra?.roi,annotation=view?{corners:view.img,ids:view.ids,columns:(manifests.calibration?.board?.squares?.[0]||8)-1}:roi?{roi}:null;if(view)lastCalibrationCorners=annotation;
    await showFrame(split,frames(split).findIndex(f=>f.file===data.file),{file:data.file},data.blob,annotation);
    const processingMs=(data.processingMs||0)+performance.now()-displayStarted,pace=$(p+'speed').value;
    // Work / (work + hold) = 0.75. Adapt to actual decoding/extraction speed.
    const holdMs=pace==='auto75'?processingMs/3:Number(pace);
    $(p+'frame-image').dataset.processingMs=String(processingMs);$(p+'frame-image').dataset.holdMs=String(holdMs);$(p+'frame-image').dataset.processingFrame=String(data.done);
    if(holdMs>0)await new Promise(resolve=>setTimeout(resolve,holdMs));
    if(active===worker)active.postMessage({type:'frame-shown',done:data.done});
   }catch(error){if(active===worker){status(error.message,true,split);finish();}}}
  }else if(data.type==='calibrated'||data.type==='result'){
   data.elapsedMs=performance.now()-started;
   await leaveScanFullscreen(split);if(active!==worker)return;
   if(data.type==='calibrated')displayCalibration(data);else displayValidation(data);
   finish();if(data.type==='result')goStep(4);else guideCalibrationReview();
  }else if(data.type==='error'){status(data.message,true,split);finish();}
 };
 await showFrame(split,0);if(active!==worker)return;
 active.postMessage({action:split==='calibration'?'calibrate':'validate',dataset:datasets[split],config:config(split),calibration:split==='validation'?calibration:undefined,mono:MONO});
}
form.addEventListener('submit',e=>{e.preventDefault();run('calibration');});$('validate').addEventListener('click',()=>run('validation'));
fields.addEventListener('input',()=>{clearCalibration();status('changed');state();});$('reset').addEventListener('click',()=>select('calibration',datasets.calibration,true));
for(const id of ['cancel','v-cancel'])$(id).addEventListener('click',()=>{const split=busy;finish();if(split==='calibration')clearCalibration();else clearValidation();if(split){scanned[split]=false;queueSpectralFrame(split);}status(split==='calibration'?'cancelled':'validationCancelled',false,split);state();});
root.querySelectorAll('[data-dataset]').forEach(b=>b.addEventListener('click',()=>select('calibration',b.dataset.dataset)));
root.querySelectorAll('[data-validation-dataset]').forEach(b=>b.addEventListener('click',()=>select('validation',b.dataset.validationDataset)));
root.querySelectorAll('.ll-stepper [data-step]').forEach(b=>b.addEventListener('click',()=>goStep(+b.dataset.step)));
for(const [id,n]of [['to-validation',3],['back-calibration',2],['to-result',4],['back-validation',3]])$(id).addEventListener('click',()=>goStep(n));
const spectralForm=$('spectral-form');
for(const [id,kind]of [['laser-preset','laser'],['filter-preset','filter'],['ambient-preset','ambient']])$(id).addEventListener('change',()=>applyPreset(kind,$(id).value));
spectralForm.addEventListener('input',()=>refreshSpectral(true));
spectralForm.addEventListener('change',()=>refreshSpectral(true));
$('spectral-reset').addEventListener('click',()=>{spectralForm.reset();for(const key of Object.keys(curveOverrides))curveOverrides[key]=null;applyPreset('laser','blue450');applyPreset('filter','standard40');applyPreset('ambient','led5000');refreshSpectral(true);});
// Changing a group's own controls discards a hand-drawn curve for that series,
// otherwise the drawing would mask the newly chosen part.
for(const [series,ids]of Object.entries(CURVE_CONTROLS))for(const id of ids)for(const type of ['input','change'])$(id).addEventListener(type,()=>clearCurveOverride(series));
$('curve-add').addEventListener('click',()=>{const {series,index}=curveMenu,points=series?curveOverrides[series]:null;closeCurveMenu();if(!points||!points[index])return;const after=points[index+1];addCurvePoint({series,nm:after?(points[index].nm+after.nm)/2:Math.min(LAMBDA_MAX-1,points[index].nm+20)});});
$('curve-delete').addEventListener('click',()=>{const {series,index}=curveMenu;closeCurveMenu();if(series&&index>=0)deleteCurvePoint(series,index);});
document.addEventListener('pointerdown',event=>{const menu=$('curve-menu');if(menu&&!menu.hidden&&!event.target?.closest?.('#ll-curve-menu'))closeCurveMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeCurveMenu();});
$('spectrum-zoom-in').addEventListener('click',()=>spectrumPlot?.zoomBy(1.5));
$('spectrum-zoom-out').addEventListener('click',()=>spectrumPlot?.zoomBy(1/1.5));
$('spectrum-zoom-reset').addEventListener('click',()=>spectrumPlot?.reset());
// One spectrum at a time: the picker decides which curve's knots are editable.
if($('curve-series'))$('curve-series').addEventListener('change',()=>spectrumPlot?.setEditSeries($('curve-series').value));
for(const button of root.querySelectorAll('#ll-spectrum-legend [data-series]'))button.addEventListener('click',()=>{const key=button.dataset.series;spectralSeries[key]=!spectralSeries[key];button.setAttribute('aria-pressed',String(spectralSeries[key]));spectrumPlot?.setVisible(spectralSeries);});
for(const split of ['calibration','validation']){
 const p=prefix(split);$(p+'frame').addEventListener('input',()=>{stopPlay(split);showFrame(split,+$(p+'frame').value);});
 $(p+'play').addEventListener('click',()=>{if(playing[split]){stopPlay(split);return;}if(!manifests[split])return;$(p+'play').textContent='Ⅱ';$(p+'play').setAttribute('aria-label',text('pause'));playing[split]=setInterval(()=>showFrame(split,(+$(p+'frame').value+1)%frames(split).length),$(p+'speed').value==='auto75'?100:Math.max(100,+$(p+'speed').value));});
 $(p+'speed').addEventListener('change',()=>stopPlay(split));
}
// The rig uses the same zoom / rotate / reset tool row as the image steps, and
// its presets look at the scanner side so the board face stays visible.
const RIG_VIEWS={iso:[Math.PI-0.85,-.32],front:[Math.PI,0],top:[Math.PI,-Math.PI/2],side:[Math.PI-Math.PI/2,0]};
const PRESETS={rig:['rig-home-view','rig-front-view','rig-top-view','rig-side-view'],view:['home-view','front-view','top-view','side-view']};
const setPresetPressed=(group,id)=>{for(const other of PRESETS[group])$(other)?.setAttribute('aria-pressed',String(other===id));};
const setRigView=(preset,mark=false)=>{const [yaw,pitch]=RIG_VIEWS[preset]||RIG_VIEWS.iso;rigViewer.yaw=yaw;rigViewer.pitch=pitch;rigViewer.zoom=1.1;rigViewer.pan=[0,0];rigViewer.draw();if(mark)setPresetPressed('rig',preset==='iso'?'rig-home-view':`rig-${preset}-view`);};
const rigTools=$('rig-tools'),rigZoom=()=>{const out=rigTools.querySelector('output');if(out)out.value=Math.round((rigViewer?.zoom||1.1)/1.1*100)+'%';};
for(const [id,preset]of [['rig-home-view','iso'],['rig-front-view','front'],['rig-top-view','top'],['rig-side-view','side']])$(id).addEventListener('click',()=>{setRigView(preset,true);rigZoom();});
rigTools.addEventListener('click',e=>{const action=e.target.closest('[data-rig-action]')?.dataset.rigAction;if(!action)return;if(action==='in')rigViewer.zoomBy(1.25);else if(action==='out')rigViewer.zoomBy(.8);else if(action==='left')rigViewer.rotateBy(-45);else if(action==='right')rigViewer.rotateBy(45);else if(action==='reset')setRigView('iso');rigZoom();});
$('to-rig').addEventListener('click',()=>goStep(1));
$('to-calibration').addEventListener('click',()=>goStep(2));
// Head geometry: the baseline and the head-to-object distance drive the rig.
for(const id of ['rig-baseline','rig-distance'])$(id).addEventListener('input',()=>updateRig(manifests.calibration,true));
$('rig-geometry-reset').addEventListener('click',()=>{setRigGeometry(manifests.calibration);updateRig(manifests.calibration,true);});
function stopOrbit(){viewer?.orbit(false);$('orbit').setAttribute('aria-pressed','false');}
const viewerZoom=()=>{const out=$('viewer-zoom');if(out)out.value=Math.round((viewer?.zoom||1.1)/1.1*100)+'%';};
for(const [id,preset]of [['home-view','iso'],['front-view','front'],['top-view','top'],['side-view','side']])$(id).addEventListener('click',()=>{stopOrbit();viewer?.reset(preset);viewerZoom();setPresetPressed('view',id);});
$('zoom-in').addEventListener('click',()=>{viewer?.zoomBy(1.2);viewerZoom();});$('zoom-out').addEventListener('click',()=>{viewer?.zoomBy(1/1.2);viewerZoom();});
$('orbit').addEventListener('click',()=>{const value=!viewer.autoOrbit;viewer.orbit(value);$('orbit').setAttribute('aria-pressed',String(value));});
$('viewer').addEventListener('pointerdown',stopOrbit);$('viewer').addEventListener('wheel',stopOrbit,{passive:true});
$('render-mode').addEventListener('change',()=>{viewer.mode=$('render-mode').value;viewer.draw();});$('color').addEventListener('change',()=>{viewer.color=$('color').value;viewer.draw();});$('point-size').addEventListener('input',()=>{viewer.pointSize=+$('point-size').value;viewer.draw();});$('bounding-box').addEventListener('change',()=>{viewer.showBox=$('bounding-box').checked;viewer.draw();});
const fullscreenTargets=[['calibration-fullscreen','calibration-scan'],['validation-fullscreen','validation-scan'],['fullscreen','viewer-panel']];
for(const [button,panel]of fullscreenTargets){
 $(button).hidden=!document.fullscreenEnabled;
 $(button).addEventListener('click',async()=>{try{if(document.fullscreenElement===$(panel))await document.exitFullscreen();else await $(panel).requestFullscreen();}catch{/* The inline scan and viewer remain usable when fullscreen is unavailable. */}});
}
document.addEventListener('fullscreenchange',()=>{
 for(const [button,panel]of fullscreenTargets){const active=document.fullscreenElement===$(panel);$(button).setAttribute('aria-pressed',String(active));const el=$(button),label=text(active?'exitFullscreen':'fullscreen');el.textContent=active?'↙':'⛶';el.setAttribute('aria-label',label);el.setAttribute('title',label);}
 viewer?.draw();
});
function savePly(data,name){if(!data)return;const lines=['ply','format ascii 1.0','comment NIDVUE synthetic validation reconstruction; units mm',`element vertex ${data.metrics.points}`,'property float x','property float y','property float z','property uchar red','property uchar green','property uchar blue','property float error_mm','end_header'];for(let i=0;i<data.errors.length;i++)lines.push([...data.points.slice(i*3,i*3+3)].map(v=>v.toFixed(5)).join(' ')+' '+[...data.colors.slice(i*3,i*3+3)].map(v=>Math.round(v*255)).join(' ')+' '+data.errors[i].toFixed(5));save(name,lines.join('\n')+'\n','text/plain');}
$('ply').addEventListener('click',()=>savePly(result,datasets.calibration+'-'+datasets.validation+'.ply'));
$('calibration-markdown').addEventListener('click',()=>{if(calibration)save(calibration.dataset+'-calibration.md',calibrationMarkdown(calibration,manifests.calibration,text,root.dataset.locale),'text/markdown;charset=utf-8');});
$('calibration-powerpoint').addEventListener('click',async()=>{
 if(!calibration||exporting)return;const snapshot=calibration,manifest=manifests.calibration;exporting=true;state();$('export-status').textContent=text('reportPreparing');
 try{const blob=await calibrationPowerpoint(snapshot,manifest,text,root.dataset.locale);save(snapshot.dataset+'-calibration.pptx',blob,'application/vnd.openxmlformats-officedocument.presentationml.presentation');$('export-status').textContent='';}
 catch{$('export-status').textContent=text('reportFailed');}finally{exporting=false;state();}
});
$('calibration-report').addEventListener('click',()=>{if(calibration)save(calibration.dataset+'-calibration.json',JSON.stringify(calibration,null,2)+'\n','application/json');});
// ---------------------------------------------------------- spectral design
// Step 0 designs the illumination and the lens filter. Every frame shown in
// steps 1-2 is re-rendered from the reference capture with the current design
// (WebGPU, WebGL2 or CPU), and the scan worker applies the same transform, so
// the point cloud in step 3 matches what is on screen.
const spectralGeometryFor=split=>{
 const m=manifests[split];if(!m)return null;const camera=calibration?.camera;
 return {width:m.width,height:m.height,cx:camera?.cx??m.width/2,cy:camera?.cy??m.height/2,focal:camera?.fx??m.fx??1665};
};
function spectralInputs(){
 const laser=LASER_PRESETS[$('laser-preset').value]||LASER_PRESETS.blue450;
 const filter=FILTER_PRESETS[$('filter-preset').value]||FILTER_PRESETS.standard40;
 return {center:laser.center,fwhm:+$('laser-fwhm').value,modes:+$('laser-modes').value,filterEnabled:filter.enabled,
  filterFwhm:+$('filter-fwhm').value,filterPeak:+$('filter-peak').value/100,filterOd:+$('filter-od').value,
  ambient:$('ambient-preset').value,ambientLevel:+$('ambient-level').value,sensor:$('sensor-preset').value};
}
// Field angle of the frame corner: where the interference filter shifts the
// most and the stripe is dimmest.
function fieldAngle(){
 const geometry=spectralGeometryFor('calibration')||spectralGeometryFor('validation')||{width:1920,height:1080,cx:960,cy:540,focal:1665};
 return Math.atan2(Math.hypot(geometry.width/2,geometry.height/2),geometry.focal)*180/Math.PI;
}
// The worker receives the same numbers the frames were rendered with.
// The worker runs the same transform the frames were rendered with: the object
// scan carries the bandpass, the calibration capture is the ambient-lit scene
// without it, so its brightness follows the designed ambient.
function spectralConfig(split){
 const geometry=spectralGeometryFor(split);if(!geometry)return null;
 const spec=transformSpec(spectralDesign,geometry,split==='validation'?'filtered':'reference');
 return {ambient:spec.ambient,tint:spec.tint,laser:spec.laser,color:spec.color,curve:Array.from(spec.curve),maxAngle:spec.maxAngle,cx:spec.cx,cy:spec.cy,focal:spec.focal};
}
let spectralQueue=Promise.resolve();
function queueSpectralFrame(split){
 spectralQueue=spectralQueue.then(()=>renderSpectralFrame(split)).catch(()=>{});
 return spectralQueue;
}
async function renderSpectralFrame(split){
 // Every split shows the ambient capture — the scene as the camera sees it,
 // without the lens filter — until its scan starts; the calibration job
 // processes that capture as-is. While the object scan runs, step 2 shows
 // the scanner's view instead: the bandpass filter, the designed stripe
 // colour and the angle roll-off.
 const p=prefix(split),img=$(p+'frame-image'),canvas=$(p+'spectral-canvas');
 if(!canvas||!img.naturalWidth)return;
 const mode=split==='validation'&&scanned.validation?'filtered':'reference';
 if(split==='validation'){const chip=$('v-mode-chip');if(chip)chip.textContent=text(mode==='filtered'?(spectralDesign.params.filterEnabled?'filteredChip':'filteredChipOff'):'ambientChip');}
 const geometry=spectralGeometryFor(split);if(!geometry){canvas.hidden=true;return;}
 // The bitmap must survive between frames: assigning width/height — even the
 // same value — clears the canvas, and the GPU render awaits real work before
 // it redraws. The compositor then paints the cleared canvas and the bright raw
 // capture flashes through under it: one flicker per displayed frame.
 if(canvas.width!==geometry.width)canvas.width=geometry.width;
 if(canvas.height!==geometry.height)canvas.height=geometry.height;
 try{
  const gpu=await applySpectralFrame(img,spectralDesign,geometry,mode),ctx=canvas.getContext('2d');
  if(gpu)ctx.drawImage(gpu.canvas,0,0,canvas.width,canvas.height);
  else{ctx.drawImage(img,0,0,canvas.width,canvas.height);const data=ctx.getImageData(0,0,canvas.width,canvas.height);applySpectral(data.data,transformSpec(spectralDesign,geometry,mode));ctx.putImageData(data,0,0);}
  // The preview pans and zooms the image element; the overlay follows it.
  canvas.style.transform=img.style.transform||'';canvas.hidden=false;
  root.dataset.spectralEngine=gpu?gpu.engine:'cpu';
 }catch{canvas.hidden=true;}
}
function refreshSpectral(reapply){
 spectralDesign=spectralModel(spectralInputs(),curveOverrides);
 if(!spectrumPlot){spectrumPlot=new SpectrumPlot($('spectrum'),{onAddPoint:addCurvePoint,onMenu:openCurveMenu,onMovePoint:moveCurvePoint,onCommit:commitCurveEdit,onView:showSpectrumSpan,labels:spectrumLabels()});window.__spectrumPlot=spectrumPlot;window.__curveOverrides=curveOverrides;}
 spectrumPlot.setLabels(spectrumLabels());spectrumPlot.setEditSeries($('curve-series')?.value||'laser');spectrumPlot.setControlPoints(curveOverrides);spectrumPlot.setModel(spectralDesign);spectrumPlot.setVisible(spectralSeries);
 $('s-laser').textContent=formats.percent(spectralDesign.laserTransmission);
 $('s-ambient').textContent=formats.percent(spectralDesign.ambientTransmission);
 $('s-contrast').textContent=formats.number(spectralDesign.contrastGain,1)+' ×';
 const cornerAtField=transmissionAt(spectralDesign,fieldAngle());
 $('s-corner').textContent=formats.percent(cornerAtField);
 gradeSpectral(spectralDesign,cornerAtField);
 updateSpectralSummaries();
 // Both frame windows announce the lens filter at their top left, so the state
 // of the glass is readable while the frames run; the design on page 00
 // decides, and every change there lands here.
 const filterOn=spectralDesign.params.filterEnabled;
 for(const id of ['calibration-filter-hint','validation-filter-hint']){const hint=$(id);if(hint){hint.textContent=text(filterOn?'filterOnHint':'filterOffHint');hint.dataset.filter=filterOn?'on':'off';}}
 $('laser-fwhm-output').value=formats.number(+$('laser-fwhm').value,1)+' nm';
 $('filter-fwhm-output').value=formats.number(+$('filter-fwhm').value,0)+' nm';
 $('filter-peak-output').value=formats.number(+$('filter-peak').value,0)+' %';
 $('ambient-level-output').value=formats.percent(+$('ambient-level').value);
 const swatch=$('s-color').querySelector('.ll-swatch');
 if(swatch)swatch.style.background=`rgb(${spectralDesign.stripeColor.map(v=>Math.round(Math.min(1,Math.max(0,v))*255)).join(' ')})`;
 // The rig preview follows the design in realtime without losing its camera.
 if(reapply){updateRig(manifests.calibration,true);queueSpectralFrame('calibration');queueSpectralFrame('validation');}
}
// The heavy half of a curve drag (rig + re-rendered frames) is coalesced into
// one animation frame so dragging stays smooth.
function scheduleHeavy(){
 if(heavyPending)return;
 heavyPending=requestAnimationFrame(()=>{heavyPending=null;updateRig(manifests.calibration,true);queueSpectralFrame('calibration');queueSpectralFrame('validation');});
}
// The first edit of a series seeds its control points from the current model
// curve, so the shape is preserved while it is being edited.
function curveFor(series){return curveOverrides[series]||(curveOverrides[series]=controlPointsFor(spectralDesign[series]));}
function addCurvePoint({series,nm}){
 if(!spectralDesign[series])return;
 const points=curveFor(series);
 points.push({nm,value:sampleAt(spectralDesign[series],nm)});
 points.sort((a,b)=>a.nm-b.nm);
 closeCurveMenu();
 refreshSpectral(false);scheduleHeavy();
}
function moveCurvePoint({series,index,nm,value}){
 const points=curveOverrides[series];
 if(!points||!points[index])return;
 // A knot stays between its neighbours, so the curve never folds back on itself.
 const low=index>0?points[index-1].nm+1:LAMBDA_MIN;
 const high=index<points.length-1?points[index+1].nm-1:LAMBDA_MAX;
 points[index]={nm:Math.max(low,Math.min(high,nm)),value:Math.max(0,Math.min(1,value))};
 refreshSpectral(false);scheduleHeavy();
}
function commitCurveEdit(){scheduleHeavy();}
function deleteCurvePoint(series,index){
 const points=curveOverrides[series];
 if(!points||!points[index])return;
 points.splice(index,1);
 if(points.length<2)curveOverrides[series]=null;
 refreshSpectral(true);
}
function clearCurveOverride(series){if(curveOverrides[series])curveOverrides[series]=null;}
function openCurveMenu({series,index,clientX,clientY}){
 curveMenu={series,index};
 if(spectrumPlot){spectrumPlot.selectedPoint={series,index};spectrumPlot.draw();}
 const menu=$('curve-menu');if(!menu)return;
 menu.hidden=false;
 menu.style.left=Math.max(8,Math.min(clientX,innerWidth-menu.offsetWidth-8))+'px';
 menu.style.top=Math.max(8,Math.min(clientY,innerHeight-menu.offsetHeight-8))+'px';
 const first=menu.querySelector('button');if(first)first.focus({preventScroll:true});
}
function closeCurveMenu(){const menu=$('curve-menu');if(menu)menu.hidden=true;if(spectrumPlot)spectrumPlot.selectedPoint=null;spectrumPlot?.draw();curveMenu={series:null,index:-1};}
// Each row summarises the effective numbers, so the panel stays readable while
// the fine adjustments are collapsed and still reports what a change did.
function updateSpectralSummaries(){
 const model=spectralDesign,params=model.params;
 if($('laser-summary'))$('laser-summary').textContent=`${formats.number(params.center,0)} nm · ${formats.number(params.fwhm,1)} nm FWHM`;
 if($('filter-summary'))$('filter-summary').textContent=params.filterEnabled?`${formats.number(params.filterFwhm,0)} nm · ${formats.number(params.filterPeak*100,0)} % · OD ${formats.number(params.filterOd,0)}`:text('filterOff');
 if($('sensor-summary'))$('sensor-summary').textContent=`QE ${formats.percent(Math.max(...model.qe))}`;
 const ambient=AMBIENT_PRESETS[params.ambient]||AMBIENT_PRESETS.led5000;
 if($('ambient-summary'))$('ambient-summary').textContent=`${formats.number(ambient.cct,0)} K · ${formats.percent(params.ambientLevel)}`;
}
// The zoom readout matches the other view toolbars: the visible span.
function showSpectrumSpan(view){const out=$('spectrum-zoom-output');if(out)out.value=formats.number(view.x1-view.x0,0)+' nm';}
function spectrumLabels(){return {x:text('spectrumWavelength'),y:text('spectrumMagnitude')};}
// Selecting a catalogue part fills its stated numbers into the sliders.
function applyPreset(kind,key){
 if(kind==='laser'){const laser=LASER_PRESETS[key];if(!laser)return;$('laser-fwhm').value=String(laser.fwhm);$('laser-modes').value=String(laser.modes);}
 if(kind==='filter'){const filter=FILTER_PRESETS[key];if(!filter)return;$('filter-fwhm').value=String(filter.fwhm);$('filter-peak').value=String(Math.round(filter.tpeak*100));$('filter-od').value=String(filter.od);}
 if(kind==='ambient'){const preset=AMBIENT_PRESETS[key];if(!preset)return;$('ambient-level').value=String(preset.level);}
}
window.addEventListener('pagehide',()=>{worker?.terminate();viewer?.setActive(false);rigViewer?.setActive(false);for(const s of ['calibration','validation']){stopPlay(s);imagePreviews[s].resize.disconnect();if(previewBlobs[s])URL.revokeObjectURL(previewBlobs[s]);}});
let ready=true;try{if(!window.Worker||!window.WebAssembly||!window.OffscreenCanvas||!window.DecompressionStream)throw new Error('browserError');viewer=new ScanViewer($('viewer'),$('axis-labels'));rigViewer=new ScanViewer($('rig-viewer'),$('axis-labels-rig'));}catch(error){ready=false;status(error.message||'browserError',true);}if(ready){try{await select('calibration',datasets.calibration);}catch(error){status(error.message||'browserError',true);}}try{refreshSpectral(false);}catch{}goStep(ready?0:2,false);state();
