// SPDX-License-Identifier: GPL-3.0-or-later

/* Calibration is a two-pass job: detect the ChArUco corners on every frame
 * (which are shown live), calibrate the camera intrinsics and lens distortion
 * from those corners, then undistort the laser stripe and fit the plane. */
import {boardRuntime,detectView,calibrateViews,poseView,undistortPoint} from './board-pose.js';
import {fitEncoderModel} from './encoder-model.js';
import {determineRoiDepth} from './stripe-roi.js';
export async function calibrateCharuco(wasm,manifest,config,read){
  const {unitMm}=manifest,fixed=manifest.acquisition==='fixed-board';
  const cv=await boardRuntime(),planes={},fits=[],encoderSamples=[],poses=[],views=[],depths=[];
  const model=config.distortionModel||'brown';
  const fit=()=>{
    const e=manifest.emitterCamera;
    if(!wasm.fitPlane(config.outlierMm/unitMm,fixed,e[0],e[1],e[2]))throw new Error('fitFailed');
    return Array.from(new Float64Array(wasm.memory.buffer,wasm.resultPtr(),6));
  };
  // Pass 1: detect corners on every frame; the stripe is kept for pass 2.
  for(const frame of manifest.calibration){
    const {stripe,view}=await read(frame,pixels=>({view:detectView(cv,manifest,frame,pixels,config.cornerRefinement||'off')}));
    views.push({frame,stripe,view});
  }
  const camera=calibrateViews(cv,manifest,views.map(v=>({...v.view,plane:v.frame.boardPose?.plane})),model);
  // Pass 2: pose from the calibrated camera, undistort the stripe, fit the plane.
  wasm.reset();
  for(const {frame,stripe,view} of views){
    if(fixed)wasm.reset();
    const pose=poseView(cv,view,camera);poses.push({cornerCount:pose.cornerCount,reprojectionRmse:pose.reprojectionRmse,meanShiftPx:view.meanShiftPx,maxShiftPx:view.maxShiftPx});
    const [nx,ny,nz,offset]=pose.plane;
    for(let i=0;i<stripe.length;i+=3){
      const [x,y]=undistortPoint(stripe[i],stripe[i+1],camera,model),denom=nx*x+ny*y+nz;
      if(Math.abs(denom)<1e-6)continue;
      const z=offset*config.referenceScale/denom;
      if(z>1&&z<8){wasm.addPlanePoint(x*z,y*z,z);depths.push(z);}
    }
    if(fixed){const values=fit();planes[frame.command]=values;fits.push(values);if(frame.commandPosition)encoderSamples.push({position:frame.commandPosition,plane:values});}
  }
  if(!fixed){const values=fit();planes[0]=values;fits.push(values);}
  const aggregate=[fits[0][0],fits[0][1],fits[0][2],Math.sqrt(fits.reduce((s,f)=>s+f[3]*f[3],0)/fits.length),fits.reduce((s,f)=>s+f[4],0),fits.reduce((s,f)=>s+f[5],0)];
  const encoderModel=encoderSamples.length?fitEncoderModel(encoderSamples,manifest.emitterCamera):null;
  // Automatic search ROI: the depths the reference target actually occupied,
  // widened by the standoff uncertainty. Computed once, reused for every
  // validation frame of this calibration.
  const stripeRoi=determineRoiDepth(depths,config.roiDepthMargin??.2);
  const planeSummary=fixed?[`${fits.length} command-specific laser planes; known emitter baseline = ${config.emitterBaseline.toFixed(2)} mm`,`Y + nx X + nz Z = d; each plane passes through the emitter`,`nx range: ${Math.min(...fits.map(f=>f[0])).toFixed(5)} … ${Math.max(...fits.map(f=>f[0])).toFixed(5)}`]:[`Fixed plane: Y + (${fits[0][0].toFixed(6)}) X + (${fits[0][1].toFixed(6)}) Z = ${fits[0][2].toFixed(6)}`,`${manifest.calibration.length} board poses; validation translates the rigid camera and laser head together on the recorded stage`];
  if(encoderModel)planeSummary.push(`Encoder map normal RMSE = ${encoderModel.normalRmse.toFixed(6)}`);
  const refinement={mode:config.cornerRefinement||'off',frames:poses.length,corners:poses.reduce((n,p)=>n+p.cornerCount,0),meanShiftPx:poses.reduce((n,p)=>n+p.meanShiftPx,0)/poses.length,maxShiftPx:Math.max(...poses.map(p=>p.maxShiftPx))};
  const boardMetrics={...manifest.boardMetrics,reprojectionRmse:Math.sqrt(poses.reduce((n,p)=>n+p.reprojectionRmse**2,0)/poses.length),minCorners:Math.min(...poses.map(p=>p.cornerCount)),refinement};
  return {fit:aggregate,planeFits:planes,encoderModel,planeSummary,boardMetrics,camera,stripeRoi};
}
