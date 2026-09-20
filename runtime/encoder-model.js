// SPDX-License-Identifier: GPL-3.0-or-later

/** Estimate an encoder-to-normal map from recovered calibration planes.
 * Encoder readings are acquisition metadata; no rendered plane coefficients
 * or validation depths enter this fit. */
function solve3(matrix,values){
  const a=matrix.map((row,i)=>[...row,values[i]]);
  for(let i=0;i<3;i++){
    let pivot=i;for(let j=i+1;j<3;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;
    if(Math.abs(a[pivot][i])<1e-10)throw new Error('fitFailed');
    [a[i],a[pivot]]=[a[pivot],a[i]];const scale=a[i][i];for(let k=i;k<4;k++)a[i][k]/=scale;
    for(let j=0;j<3;j++){if(j===i)continue;const weight=a[j][i];for(let k=i;k<4;k++)a[j][k]-=weight*a[i][k];}
  }
  return a.map(row=>row[3]);
}
export function fitEncoderModel(samples,emitter){
  if(samples.length<10)throw new Error('fitFailed');
  const fit=axis=>{
    let coefficients=[0,0,0];
    for(let pass=0;pass<5;pass++){
      const matrix=Array.from({length:3},()=>[0,0,0]),rhs=[0,0,0];
      for(const {position,plane}of samples){
        const row=[1,...position],residual=plane[axis]-row.reduce((s,v,i)=>s+v*coefficients[i],0),w=pass?Math.min(1,.002/Math.max(1e-10,Math.abs(residual))):1;
        for(let i=0;i<3;i++){rhs[i]+=row[i]*plane[axis]*w;for(let j=0;j<3;j++)matrix[i][j]+=row[i]*row[j]*w;}
      }
      coefficients=solve3(matrix,rhs);
    }
    return coefficients;
  };
  const model={nx:fit(0),nz:fit(1),emitter,bounds:[0,1].map(axis=>[Math.min(...samples.map(s=>s.position[axis])),Math.max(...samples.map(s=>s.position[axis]))])};
  const residuals=samples.map(s=>{const p=planeAt(model,s.position);return Math.hypot(p[0]-s.plane[0],p[1]-s.plane[1]);});
  model.normalRmse=Math.sqrt(residuals.reduce((s,r)=>s+r*r,0)/residuals.length);return model;
}
export function planeAt(model,position){
  if(!Array.isArray(position)||position.length!==2||position.some((v,i)=>!Number.isFinite(v)||v<model.bounds[i][0]-1e-5||v>model.bounds[i][1]+1e-5))throw new Error('commandRange');
  const row=[1,...position],nx=model.nx.reduce((s,v,i)=>s+v*row[i],0),nz=model.nz.reduce((s,v,i)=>s+v*row[i],0);
  return[nx,nz,model.emitter[1]+nx*model.emitter[0]+nz*model.emitter[2]];
}
