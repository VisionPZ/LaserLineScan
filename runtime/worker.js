/* Calibration and validation are separate jobs. Validation can only consume an
 * explicitly selected compatible split and an already fitted calibration. */
import {undistortPoint} from './board-pose.js';
import {calibrateCharuco} from './charuco-worker.js';
import {bandUncertaintyOptions,bandRows,determineRoiDepth,framePlane,resolveDepthPrior,resolveObjectColumns,searchBand} from './stripe-roi.js';
import {loadRowGate,gateSpan} from './rows-pca.js';
import {recoverColumns} from './scatter.js';
import {applySpectral} from './spectral.js';
let wasm;
async function get(url,type='json'){
  const response=await fetch(url);if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);
  if(type==='buffer'&&String(url).endsWith('.gz'))return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return type==='json'?response.json():type==='blob'?response.blob():response.arrayBuffer();
}
// Start fetching every frame image, reporting progress as each one lands. The
// map holds *promises*, so the transfers of the later frames overlap the
// processing of the earlier ones instead of finishing first: the network never
// sits idle while the CPU works. A failure still surfaces when the frame is
// read.
function startFrames(frames,base){
  const buffered=new Map();let next=0,done=0;
  const run=async()=>{while(next<frames.length){const frame=frames[next++];const blob=get(new URL(frame.file,base),'blob');
    buffered.set(frame.file,blob);
    // Keep a rejection from escaping as unhandled if the job fails before this
    // frame is read; the consumer still sees it on its own promise.
    blob.then(()=>self.postMessage({type:'buffering',done:++done,total:frames.length}),()=>{});
  }};
  // The browser caps connections per host anyway; eight keeps the queue fed.
  Array.from({length:Math.min(8,frames.length)},run);
  return buffered;
}
// Truth volumes are depth maps: gzipped float32 by default, or uint16 when the
// manifest declares it (a demo build quantises them — about a third of the size,
// with a quantum far below the error the scan reports). 0 always means "no data".
function decodeTruth(buffer,encoding){
  if(!encoding||encoding.type!=='u16')return new Float32Array(buffer);
  const counts=new Uint16Array(buffer),scale=encoding.scale,offset=encoding.offset||0,out=new Float32Array(counts.length);
  for(let i=0;i<counts.length;i++){const v=counts[i];out[i]=v?v*scale+offset:0;}
  return out;
}
function sample(depth,x,y,width,height){
  const u=Math.floor(x-.5),v=Math.floor(y-.5);
  if(u<0||v<0||u>=width-1||v>=height-1)return 0;
  const a=depth[v*width+u],b=depth[v*width+u+1],c=depth[(v+1)*width+u],d=depth[(v+1)*width+u+1];
  if(!a||!b||!c||!d||Math.max(a,b,c,d)-Math.min(a,b,c,d)>.035)return 0;
  const dx=x-.5-u,dy=y-.5-v;return(a*(1-dx)+b*dx)*(1-dy)+(c*(1-dx)+d*dx)*dy;
}
// Trained row subspace (tools/laser/rows-pca.py). Loaded once; if the asset is
// missing the scan simply falls back to the calibrated ROI alone.
let rowGate;
async function getRowGate(){
  if(rowGate!==undefined)return rowGate;
  try{const meta=await get(new URL('rows-pca.json',import.meta.url)),buffer=await get(new URL('rows-pca.f32',import.meta.url),'buffer');rowGate=loadRowGate(meta,buffer);}catch{rowGate=null;}
  return rowGate;
}
// Intersect each column's calibrated band with the row span the subspace keeps.
function applyRowGate(gate,band,pixels,width,height){
  if(gate.dim!==Math.floor((width-1)/gate.stride)+1)return;
  let lo=height,hi=0;
  for(let x=0;x<band.top.length;x++){if(band.bottom[x]<=band.top[x])continue;if(band.top[x]<lo)lo=band.top[x];if(band.bottom[x]>hi)hi=band.bottom[x];}
  if(hi<=lo)return;
  const span=gateSpan(gate,pixels,width,lo,hi);
  if(!span)return;
  const top=span[0],bottom=span[1]+1;
  for(let x=0;x<band.top.length;x++){if(band.top[x]<top)band.top[x]=top;if(band.bottom[x]>bottom)band.bottom[x]=bottom;}
}
self.onmessage=async({data})=>{
 try{
  const {action,dataset}=data,calibrating=action==='calibrate';
  if(!['calibrate','validate'].includes(action))throw new Error('Invalid operation');
  if(!/^[a-z-]+$/.test(dataset))throw new Error('Invalid dataset');
  const split=calibrating?'calibration':'validation';
  const calibrationId=calibrating?dataset:data.calibration?.dataset;
  if(!['charuco-fixed-board','charuco-moving-board'].includes(calibrationId))throw new Error('incompatible');
  // The job carries which dataset root to read: the app switches the object
  // scan to the monochrome set with ?mono=1, and the calibration board stays on
  // the colour path either way.
  const base=new URL(calibrating?`demo/calibration/${dataset}/`:`${data.mono?'hd-mono':'demo'}/validation/${calibrationId}/${dataset}/`,new URL('../',import.meta.url));
  const manifest=await get(new URL('manifest.json',base));
  const calibration=data.calibration;
  if(!calibrating&&(!calibration||calibration.dataset!==manifest.calibrationId||calibration.rigId!==manifest.rigId))throw new Error('incompatible');
  const config=calibrating?data.config:{...calibration.config,...(data.config||{})};
  if(!wasm){const binary=await get(new URL('core.wasm',import.meta.url),'buffer');wasm=(await WebAssembly.instantiate(binary,{env:{abort(){throw new Error('Numerical kernel aborted');}}})).instance.exports;}
  const {width,height,unitMm}=manifest;
  // A monochrome capture is one byte per pixel. The kernel then scores the
  // pixel's own intensity instead of the colour blue-excess that isolates the
  // laser line from the ambient: the bandpass filter already does that
  // spectrally, so the extra channels only cost bandwidth and cache.
  const mono=manifest.channels===1||manifest.mono===true;
  const gray=mono?new Uint8Array(width*height):null;
  if(!wasm.configureImage(width,height,mono?1:4))throw new Error('Unsupported image dimensions');
  // The capture transform is configured once per job: it builds a per-pixel
  // angle-gain field, which must not be rebuilt for every frame.
  if(!mono&&wasm.shade&&config.spectral){
    const {ambient,laser,tint,color,cx,cy,focal,maxAngle,curve}=config.spectral;
    new Float64Array(wasm.memory.buffer,wasm.shadingCurvePtr(),91).set(curve);
    wasm.configureShading(ambient,laser,tint[0],tint[1],tint[2],color[0],color[1],color[2],cx,cy,focal,maxAngle);
  }
  // The kernel's blue-excess family only sees a blue line, and with a spectral
  // design the line is drawn in the *designed* colour: score along that
  // direction instead (kernel mode 2). Declared before the frame readers because
  // the calibration path reads frames too.
  const spectralScore=!mono&&!!config.spectral&&typeof wasm.setScorePlane==='function';
  const scoreMode=spectralScore?2:config.channel;
  if(!calibrating&&['width','height','unitMm'].some(k=>manifest[k]!==calibration.camera[k]))throw new Error('incompatible');
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
  const frames=config.direction===manifest.direction?manifest[split]:[...manifest[split]].reverse();
  let done=0,buffered;
  // Expand only the columns whose excluded score still exceeds the threshold,
  // up to the pass budget; anything left after that stays unqualified.
  const recoverBand=(band,verify,mode)=>{
    if(!(band&&verify&&verify.right>verify.left))return null;
    const writeBand=()=>{new Int32Array(wasm.memory.buffer,wasm.bandTopPtr(),width).set(band.top);new Int32Array(wasm.memory.buffer,wasm.bandBottomPtr(),width).set(band.bottom);};
    let passes=0,expandedColumns=0,count=null,flagged=wasm.verifyExcluded(mode,verify.left,verify.right);
    while(flagged>0&&passes<verify.maxPasses){
      const colMax=new Int32Array(wasm.memory.buffer,wasm.excludedMaxPtr(),width);
      const colRow=new Int32Array(wasm.memory.buffer,wasm.excludedRowPtr(),width);
      const threshold=wasm.thresholdValue();
      let expanded=0;
      for(let x=verify.left;x<verify.right;x++){
        if(colMax[x]<=threshold)continue;
        const row=colRow[x];if(row<0)continue;
        const lo=Math.max(0,row-verify.margin),hi=Math.min(height,row+verify.margin+1);
        if(lo<band.top[x])band.top[x]=lo;
        if(hi>band.bottom[x])band.bottom[x]=hi;
        expanded++;
      }
      if(!expanded)break;
      writeBand();count=wasm.extractBanded(mode,config.quantile,config.threshold,config.estimator,config.roi/100);
      expandedColumns+=expanded;passes++;
      flagged=wasm.verifyExcluded(mode,verify.left,verify.right);
    }
    return{passes,expandedColumns,remaining:flagged,qualified:flagged===0,count};
  };
  // Decoding is kept off the critical path: createImageBitmap runs off-thread, so
  // the next frames are decoded while the current one is processed. Three frames
  // in flight costs about 25 MB of ImageBitmaps and hides most of the decode.
  const decoded=new Map();let decodeAt=0;
  const primeDecode=()=>{while(decoded.size<3&&decodeAt<frames.length){const f=frames[decodeAt++];decoded.set(f.file,buffered.get(f.file).then(blob=>createImageBitmap(blob)).catch(()=>null));}};
  const takeDecoded=async frame=>{
    const held=decoded.get(frame.file);decoded.delete(frame.file);
    const bitmap=held?await held:createImageBitmap(await buffered.get(frame.file));
    primeDecode();
    return bitmap||createImageBitmap(await buffered.get(frame.file));
  };
  const read=async(frame,processFrame,band=null,gate=null,verify=null)=>{
    const processingStarted=performance.now();
    const blob=await (buffered.get(frame.file)||get(new URL(frame.file,base),'blob')),bitmap=await takeDecoded(frame);ctx.drawImage(bitmap,0,0);bitmap.close();
    const pixels=ctx.getImageData(0,0,width,height).data;
    // Re-render the capture for the illumination designed in step 0, so the
    // point cloud and its colours match the frames shown to the user. The
    // transform is a 2 MPixel loop and runs in the kernel: measured at 79 ms per
    // frame in JavaScript against roughly a fifth of that in WebAssembly.
    if(!mono&&wasm.shade&&config.spectral){
      new Uint8Array(wasm.memory.buffer,wasm.inputPtr(),pixels.length).set(pixels);
      wasm.shade();
      pixels.set(new Uint8Array(wasm.memory.buffer,wasm.inputPtr(),pixels.length));
    }else if(!mono&&config.spectral)applySpectral(pixels,{...config.spectral,width,height});
    // Score along the designed stripe direction (kernel mode 2): the line is
    // drawn in the *designed* colour, which blue-excess cannot see. The level is
    // the projection's median, so it tracks exposure and vignetting per frame.
    // Sampled every 4th pixel — the median is robust to that and it keeps the
    // per-frame cost near 100 us instead of 5 ms.
    if(spectralScore){
      const c=config.spectral.color,n=Math.hypot(c[0],c[1],c[2])||1;
      const w0=c[0]/n,w1=c[1]/n,w2=c[2]/n;
      const hist=new Uint32Array(512);let total=0;
      for(let i=0;i<pixels.length;i+=16){
        const v=w0*pixels[i]+w1*pixels[i+1]+w2*pixels[i+2];
        hist[v<0?0:v>511?511:v|0]++;total++;
      }
      let acc=0,level=0;
      for(let v=0;v<512;v++){acc+=hist[v];if(acc>=total/2){level=v+0.5;break;}}
      wasm.setScorePlane(w0,w1,w2,level);
    }
    if(mono){
      // Only the intensity crosses into wasm: 2 MB instead of 8.3 MB per frame.
      for(let i=0,j=0;i<pixels.length;i+=4,j++)gray[j]=pixels[i];
      new Uint8Array(wasm.memory.buffer,wasm.inputPtr(),gray.length).set(gray);
    }else{
      if(gate&&band)applyRowGate(gate,band,pixels,width,height);
      new Uint8Array(wasm.memory.buffer,wasm.inputPtr(),pixels.length).set(pixels);
    }
    if(band){new Int32Array(wasm.memory.buffer,wasm.bandTopPtr(),width).set(band.top);new Int32Array(wasm.memory.buffer,wasm.bandBottomPtr(),width).set(band.bottom);}
    let n=band?wasm.extractBanded(scoreMode,config.quantile,config.threshold,config.estimator,config.roi/100):wasm.extract(scoreMode,config.quantile,config.threshold,config.estimator,config.roi/100);
    const recovery=band?recoverBand(band,verify,scoreMode):null;
    if(recovery&&recovery.count!==null)n=recovery.count;
    const stripe=new Float64Array(wasm.memory.buffer,wasm.stripePtr(),n*3).slice();
    const extra=processFrame?processFrame(pixels):{};
    const frameDone=++done,processingMs=performance.now()-processingStarted;
    // Backpressure: wait until the main thread has displayed this image for
    // the selected observation interval. Processing cannot skip visible frames.
    await new Promise(resolve=>{
      const acknowledge=event=>{if(event.data.type==='frame-shown'&&event.data.done===frameDone){self.removeEventListener('message',acknowledge);resolve();}};
      self.addEventListener('message',acknowledge);
      self.postMessage({type:'progress',stage:split,done:frameDone,total:frames.length,file:frame.file,blob,processingMs,extra});
    });
    return{stripe,pixels,recovery,...extra};
  };
  // Start the downloads and process as they land: decoding and stripe detection
  // for one frame overlap the transfers of the rest, so calibration and scanning
  // are not stalled behind a full pre-download.
  buffered=startFrames(frames,base);
  primeDecode();
  if(calibrating){
    let recovered;
    if(manifest.acquisition)recovered=await calibrateCharuco(wasm,manifest,config,read);
    else{
      const reference=new Float32Array(await get(new URL(manifest.referenceDepth,base),'buffer'));
      if(reference.length!==width*height)throw new Error('Invalid reference dimensions');wasm.reset();
      const depths=[];
      for(const frame of frames){const {stripe}=await read(frame);for(let i=0;i<stripe.length;i+=3){const z=sample(reference,stripe[i],stripe[i+1],width,height)*config.referenceScale;if(z){wasm.addReference(z,(stripe[i+1]-manifest.cy)/config.focal*z,frame.t);if(z>1&&z<8)depths.push(z);}}}
      self.postMessage({type:'progress',stage:'fit',done,total:frames.length});
      if(!wasm.fit(config.outlierMm/unitMm,config.model==='fixed',Math.tan(config.tilt*Math.PI/180)))throw new Error('fitFailed');
      recovered={fit:Array.from(new Float64Array(wasm.memory.buffer,wasm.resultPtr(),6)),stripeRoi:determineRoiDepth(depths,config.roiDepthMargin??.2)};
    }
    self.postMessage({type:'calibrated',dataset,rigId:manifest.rigId,version:manifest.version,config,...recovered,calibrationFrames:frames.length,camera:{...recovered.camera,width,height,unitMm}});return;
  }
  const cam=calibration.camera,truthSpec=manifest.truth||{},tfx=truthSpec.fx??cam.fx,tfy=truthSpec.fy??tfx,tcx=truthSpec.cx??cam.cx,tcy=truthSpec.cy??cam.cy;
  const points=[],observations=[],colors=[];
  // Calibration-derived working depth interval; each frame's calibrated plane
  // turns it into the per-column search band the kernel reuses for every
  // line-centre estimator.
  const roiDepth=resolveDepthPrior(calibration,manifest);
  // Object bounding-box prior: keep the per-column band inside the columns the
  // object can project into. Cleared columns are skipped by the kernel.
  const objectColumns=resolveObjectColumns(cam,manifest,width,config.roiMarginPx??8);
  // The learned row gate is a blue-excess basis trained on the colour captures,
  // so it does not transfer to a monochrome frame; a mono deployment would
  // retrain it with tools/laser/rows-pca.py.
  // The row gate is a blue-excess basis, so it does not apply to mode 2.
  const gate=mono||spectralScore?null:config.channel===0?await getRowGate():null;
  const uncertainty=bandUncertaintyOptions(calibration,manifest,config);
  const lateralLeft=Math.floor(width*(1-config.roi/100)/2),lateralRight=width-lateralLeft;
  const verifyColumns=objectColumns||[lateralLeft,lateralRight];
  let scannedRows=0,rowTotal=0,outOfBandColumns=0,activeColumns=0,fallbackFrames=0,unqualifiedFrames=0,verifiedFrames=0,recoveredColumns=0;
  // Truth for a line is fetched and inflated while the later lines are still
  // being measured, so the download and its gzip inflation overlap the stripe
  // detection that dominates a scan instead of following it. The window is
  // bounded — one line's truth is a full frame of float32 (~8 MiB) — and the
  // fixed rig shares a single volume for the whole scene.
  const commonTruth=manifest.validationTruth?decodeTruth(await get(new URL(manifest.validationTruth,base),'buffer'),manifest.truthEncoding):null;
  const truthPending=new Map();let truthNext=0;
  const truthAhead=commonTruth?0:(config.truthAhead??config.truthBatch??8);
  const pumpTruth=()=>{while(truthAhead&&truthNext<frames.length&&truthPending.size<truthAhead){const ahead=frames[truthNext++];truthPending.set(ahead.file,ahead.truth?get(new URL(ahead.truth,base),'buffer').then(buffer=>decodeTruth(buffer,manifest.truthEncoding)):Promise.resolve(null));}};
  pumpTruth();
  const errorList=[];let squared=0,scored=0,expected=0,maxError=0;
  for(const frame of frames){
    const plane=framePlane(calibration,manifest,frame);
    if(manifest.acquisition&&!plane)throw new Error('incompatible');
    // One band builder for the worker, the frame-view outline and the reported
    // coverage: searchBand() reads the same depth prior, band mode, margins and
    // object-column bound for all three.
    const band=searchBand(calibration,manifest,frame,config,plane);
    const verify=band&&config.verifyBand!==false&&verifyColumns[1]>verifyColumns[0]?{left:verifyColumns[0],right:verifyColumns[1],margin:config.recoverMarginPx??6,maxPasses:config.verifyMaxPasses??2}:null;
    let {stripe,pixels,recovery}=await read(frame,band?()=>({roi:{top:band.top,bottom:band.bottom,width}}):null,band,gate,verify);
    if(band&&config.recoverMissing!==false){
      const measured=new Map();for(let i=0;i<stripe.length;i+=3)measured.set(Math.floor(stripe[i]),stripe[i+1]);
      const extra=recoverColumns(pixels,width,height,band,objectColumns||[lateralLeft,lateralRight],measured,{threshold:config.threshold,minAmplitude:config.recoverAmplitude??.15,continuity:config.recoverContinuityPx??4,shoulder:config.shoulderRecovery!==false,stride:mono?1:4,mono});
      if(extra.length){const merged=new Float64Array(stripe.length+extra.length*3);merged.set(stripe);extra.forEach((p,i)=>{merged[stripe.length+i*3]=p.x;merged[stripe.length+i*3+1]=p.y;merged[stripe.length+i*3+2]=p.amplitude;});stripe=merged;recoveredColumns+=extra.length;}
    }
    if(band){scannedRows+=bandRows(band,height);rowTotal+=width*height;activeColumns+=Math.max(0,verifyColumns[1]-verifyColumns[0]);if(recovery){verifiedFrames++;outOfBandColumns+=recovery.expandedColumns;if(recovery.expandedColumns)fallbackFrames++;if(!recovery.qualified)unqualifiedFrames++;}}
    const firstObs=observations.length;
    for(let i=0;i<stripe.length;i+=3){
      const u=stripe[i],v=stripe[i+1],[xu,yu]=undistortPoint(u,v,cam,cam.model);
      const z=plane?plane[2]/(plane[0]*xu+yu+plane[1]):
        (calibration.fit[1]+calibration.fit[2]*frame.t)/(yu+calibration.fit[0]);
      if(!Number.isFinite(z)||z<1||z>8)continue;
      const translation=frame.translation||[0,0,0];
      points.push((xu*z-translation[0])*unitMm,(yu*z-translation[1])*unitMm,(z-translation[2])*unitMm);
      const p=(Math.floor(v)*width+Math.floor(u))*4;colors.push(pixels[p]/255,pixels[p+1]/255,pixels[p+2]/255);
      observations.push({u,v,x:xu,y:yu,su:xu*tfx+tcx,sv:yu*tfy+tcy,z,t:frame.t,frame:frame.file});
    }
    // Score this line against the truth that downloaded while it was measured.
    // Observations are appended in frame order, so the errors line up with them
    // by index.
    if(commonTruth||truthAhead){
      const truth=commonTruth||await truthPending.get(frame.file);truthPending.delete(frame.file);pumpTruth();
      if(!truth||truth.length!==width*height)throw new Error('Invalid validation truth');
      const translation=frame.translation||[0,0,0];
      for(let i=firstObs;i<observations.length;i++){
        const {x,y,su,sv}=observations[i];
        const z=sample(truth,su,sv,width,height);
        if(!z){errorList.push(-1);continue;}
        const target=[x*z,y*z,z];
        const error=Math.hypot(...target.map((p,k)=>(p-translation[k])*unitMm-points[i*3+k]));
        errorList.push(error);squared+=error*error;maxError=Math.max(maxError,error);scored++;
      }
      // Honest coverage: a column is scannable when the frame's calibrated plane
      // crosses the truth surface inside the reconstruction depth range, whether
      // or not a stripe is visible there. This counts occluded and under-threshold
      // stripes as expected, so coverage cannot hide physically missing points.
      const [A,B,C]=plane;
      for(let x=0;x<width;x++){
        const xu=(x+.5-tcx)/tfx;let pz=null,pt=null;
        for(let y=0;y<height;y++){
          const zt=truth[y*width+x];
          if(!zt){pz=pt=null;continue;}
          const zp=C/(A*xu+(y+.5-tcy)/tfy+B);
          if(!(zp>=1&&zp<=8)){pz=pt=null;continue;}
          if(pz!==null&&(pz-pt)*(zp-zt)<=0){expected++;break;}
          pz=zp;pt=zt;
        }
      }
    }
  }
  if(points.length<90)throw new Error('noValidation');
  const errors=Float32Array.from(errorList);
  self.postMessage({type:'result',dataset:calibration.dataset,validationDataset:dataset,config,fit:calibration.fit,planeFits:calibration.planeFits,encoderModel:calibration.encoderModel,planeSummary:calibration.planeSummary,boardMetrics:calibration.boardMetrics,scanTopology:manifest.scanTopology,
    points:new Float32Array(points),colors:new Float32Array(colors),errors,observations,
    metrics:{points:points.length/3,scored,expected,rmse:scored?Math.sqrt(squared/scored):null,maxError,coverage:expected?Math.min(1,scored/expected):0,stripeRoi:roiDepth,scanFraction:rowTotal?scannedRows/rowTotal:1,bandMode:config.bandMode==='fixed'?'fixed':'uncertainty',bandSigmaK:uncertainty.k,verified:verifiedFrames>0&&unqualifiedFrames===0,verifiedFrames,recoveredColumns,outOfBandRate:activeColumns?outOfBandColumns/activeColumns:0,fallbackFrames,unqualifiedFrames},
    calibrationVersion:calibration.version,manifest:{version:manifest.version,object:manifest.object,acquisition:manifest.acquisition,unitMm,width,height,calibrationFrames:calibration.calibrationFrames,validationFrames:frames.length}});
 }catch(error){self.postMessage({type:'error',message:error.message});}
};
// Frame acknowledgements are consumed by read(), never as new jobs.
const handleJob=self.onmessage;
self.onmessage=event=>{if(event.data.type!=='frame-shown')handleJob(event);};
