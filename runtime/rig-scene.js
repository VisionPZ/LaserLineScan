// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>

import {CHARUCO_BOARD} from './charuco-board.js';
/** Procedural laser-camera rig for the step-0 viewer. Geometry is driven by the
 * selected calibration manifest (real intrinsics and board). The head is
 * symmetric about the scanned surface normal: the camera and the laser beam
 * each sit 17.6 deg from the normal (a 35 deg triangulation) so the beam
 * strikes the surface near-orthogonally and the line is centred. The camera's
 * field of view is drawn from the delivered intrinsics, and the beamer body is
 * built on its principal axis so that axis lies in the projected sheet. */
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
// Keep a designed spectrum colour bright enough to read against the dark scene.
const lift=(color,floor=.28)=>{const peak=Math.max(...color)||1;const scaled=color.map(v=>floor+(1-floor)*v/peak);const max=Math.max(...scaled)||1;return scaled.map(v=>v/max);};

export function buildRigScene(manifest={},design={}){
 const band=manifest.board||{squares:[8,6],squareLengthMm:40}, cols=band.squares[0], rows=band.squares[1], sq=band.squareLengthMm;
 const bw=cols*sq, bh=rows*sq;
 // Rigid triangulation head, drawn in its own frame. The camera and the laser
 // beam are symmetric about the head axis, so the half baseline and the working
 // distance alone fix their tilt: tan(theta) = (baseline / 2) / distance. The
 // two are adjustable in step 0 and every other position below is derived.
 const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
 const baseline=clamp(design.baseline??manifest.emitterBaselineMm??248,40,1200);
 const distance=clamp(design.distance??388,80,2000);
 const beamerZ=200, floorY=300, camPos=[0,-baseline,beamerZ], laserOrigin=[0,0,beamerZ];
 const tilt=Math.atan2(baseline/2,distance);
 const cosT=Math.cos(tilt), sinT=Math.sin(tilt), tanT=Math.tan(tilt);
 const boardFront=beamerZ+distance, boardZ=boardFront+3, boardY=-baseline/2;
 const head=71, beamDir=[0,-sinT,cosT];
 const aperture=[0,-sinT*head,beamerZ+cosT*head];
 // The beam crosses the head axis at the board; the fan and the stripe are
 // drawn where the beam actually lands, so they share its plane exactly.
 const patternZ=boardFront-.8, ribbonZ=boardFront-2.2;
 const ribbonY=-(ribbonZ-beamerZ)*tanT;
 const out=[];let fans=0,fov=0;
 const put=(p,n,c)=>out.push(p[0],p[1],p[2],0,n[0],n[1],n[2],c[0],c[1],c[2]);
 const tri=(a,b,c,color)=>{const n=norm(cross(sub(b,a),sub(c,a)));put(a,n,color);put(b,n,color);put(c,n,color);};
 const quad=(a,b,c,d,color)=>{tri(a,b,c,color);tri(a,c,d,color);};
 const box=(center,size,color)=>{const[x,y,z]=center,[X,Y,Z]=[size[0]/2,size[1]/2,size[2]/2];
  const p=[[x-X,y-Y,z-Z],[x+X,y-Y,z-Z],[x+X,y+Y,z-Z],[x-X,y+Y,z-Z],[x-X,y-Y,z+Z],[x+X,y-Y,z+Z],[x+X,y+Y,z+Z],[x-X,y+Y,z+Z]];
  quad(p[0],p[1],p[2],p[3],color);quad(p[4],p[5],p[6],p[7],color);
  quad(p[0],p[1],p[5],p[4],color);quad(p[2],p[3],p[7],p[6],color);
  quad(p[1],p[2],p[6],p[5],color);quad(p[0],p[4],p[7],p[3],color);};
 const cylinder=(from,to,r,seg,color,caps=true)=>{const axis=norm(sub(to,from)),ref=Math.abs(axis[1])>.9?[1,0,0]:[0,1,0],u=norm(cross(axis,ref)),w=norm(cross(axis,u));
  const ring=(t,ang)=>[from[0]+(to[0]-from[0])*t+(u[0]*Math.cos(ang)+w[0]*Math.sin(ang))*r,from[1]+(to[1]-from[1])*t+(u[1]*Math.cos(ang)+w[1]*Math.sin(ang))*r,from[2]+(to[2]-from[2])*t+(u[2]*Math.cos(ang)+w[2]*Math.sin(ang))*r];
  for(let i=0;i<seg;i++){const a0=i/seg*Math.PI*2,a1=(i+1)/seg*Math.PI*2;quad(ring(0,a0),ring(1,a0),ring(1,a1),ring(0,a1),color);}
  if(caps)for(let i=0;i<seg;i++){const a0=i/seg*Math.PI*2,a1=(i+1)/seg*Math.PI*2;tri(from,ring(0,a1),ring(0,a0),color);tri(to,ring(1,a0),ring(1,a1),color);}};
 const disc=(center,normal,r,seg,color)=>{const axis=norm(normal),ref=Math.abs(axis[2])>.9?[1,0,0]:[0,0,1],u=norm(cross(axis,ref)),w=norm(cross(axis,u));
  for(let i=0;i<seg;i++){const a0=i/seg*Math.PI*2,a1=(i+1)/seg*Math.PI*2;const p=a=>[center[0]+(u[0]*Math.cos(a)+w[0]*Math.sin(a))*r,center[1]+(u[1]*Math.cos(a)+w[1]*Math.sin(a))*r,center[2]+(u[2]*Math.cos(a)+w[2]*Math.sin(a))*r];tri(center,p(a0),p(a1),color);}};
 // Pitch positions and normals in [start,end) by `angle` about x, then move by
 // (ty,tz): one transform puts any body on a tilted head axis.
 const pitch=(start,end,angle,ty=0,tz=0)=>{const c=Math.cos(angle),s=Math.sin(angle);
  for(let i=start;i<end;i+=10){const y=out[i+1],z=out[i+2],ny=out[i+5],nz=out[i+6];
   out[i+1]=y*c-z*s+ty;out[i+2]=y*s+z*c+tz;out[i+5]=ny*c-nz*s;out[i+6]=ny*s+nz*c;}};

 // Palette. The camera field of view is a semi-transparent light gray (the
 // viewer draws the frustum range at alpha 0.14), so the two volumes stay
 // distinguishable wherever they overlap the laser sheet.
 // The ambient-lit surfaces follow the designed source: its level scales them
 // and its colour tints them, so a tungsten room warms the board and a dark room
 // dims it. The laser volumes, the field of view and the dimension rulers are
 // not ambient-lit and keep their own colours.
 const AMBIENT_LEVEL=Number.isFinite(design.ambientLevel)?design.ambientLevel:1;
 const AMBIENT_TINT=design.ambientTint||[1,1,1];
 const lit=color=>color.map((v,i)=>Math.min(1,v*AMBIENT_LEVEL*AMBIENT_TINT[i]));
 const DARK=lit([.15,.16,.18]),METAL=lit([.2,.21,.24]),GLASS=lit([.05,.13,.3]),FRAME=lit([.13,.14,.16]),FOV=[.82,.84,.88];
 // The laser volumes carry the designed spectrum, so changing the laser in the
 // step-0 panel re-colours the beam, the sheet and the projected line here.
 const LASER=lift(design.laserColor||[.35,.6,1]);
 const STRIPE=lift(design.stripeColor||[.58,.76,1]).map(v=>v*.7+.3);
 const FILTER=lift(design.filterColor||[.5,.66,.96],.45);
 const FILTER_ON=design.filterEnabled!==false;
 // Studio floor, bench post and board legs (world frame, all horizontal/vertical).
 quad([-700,floorY,-700],[700,floorY,-700],[700,floorY,900],[-700,floorY,900],lit([.08,.09,.11]));
 const grid=lit([.13,.14,.17]);
 for(let i=-7;i<=9;i++)box([0,floorY-.6,(i-1)*100],[1600,1.2,2],grid);
 for(let i=-7;i<=7;i++)box([i*100,floorY-.6,150],[2,1.2,1600],grid);
 cylinder([0,-baseline/2,beamerZ-40],[0,floorY,beamerZ-40],10,16,METAL);disc([0,floorY,beamerZ-40],[0,1,0],46,24,METAL);
 cylinder([-bw*.18,boardY+bh/2,boardZ],[-bw*.18,floorY,boardZ],6,16,FRAME);cylinder([bw*.18,boardY+bh/2,boardZ],[bw*.18,floorY,boardZ],6,16,FRAME);

 const rigStart=out.length;
 // Camera: built on its optical axis, pitched CAM_TILT down and placed at camPos.
 const camStart=out.length;
 box([0,0,0],[74,58,46],DARK);box([0,-30,0],[74,4,46],METAL);
 cylinder([0,0,23],[0,0,62],24,28,FRAME);cylinder([0,0,23],[0,0,29],27,28,METAL);disc([0,0,62.2],[0,0,1],20,28,GLASS);
 // The bandpass filter sits in the optical path; it is drawn only while engaged
 // and takes the passband's colour, so the preview shows the designed chain.
 if(FILTER_ON){cylinder([0,0,64],[0,0,67],26,28,METAL);disc([0,0,67.4],[0,0,1],24,28,FILTER);}
 const camEnd=out.length;pitch(camStart,camEnd,-tilt,camPos[1],camPos[2]);
 // Laser line beamer: body on its principal axis, pitched LASER_TILT the other
 // side of the head axis so that axis is exactly the fan's central ray.
 const beamerStart=out.length;
 box([0,0,0],[48,46,74],DARK);cylinder([0,0,37],[0,0,head],19,24,FRAME);
 disc([0,0,head+.3],[0,0,1],6,20,LASER);
 pitch(beamerStart,out.length,tilt,0,beamerZ);
 // Rigid mount keeping the base baseline.
 box([0,-baseline/2,beamerZ-40],[44,baseline+20,10],METAL);
 // Reference board, surface facing the head, plus the horizontal laser line.
 box([0,boardY,boardZ],[bw,bh,6],lit([.85,.86,.88]));
 // Exactly the same ChArUco board as the acquisition images: the dark cells are
 // sampled from the ChArUco board texture the offline renderer uses.
 const gc=bw/CHARUCO_BOARD.cols,gr=bh/CHARUCO_BOARD.rows,bits=CHARUCO_BOARD.bits;
 for(let j=0;j<CHARUCO_BOARD.rows;j++)for(let i=0;i<CHARUCO_BOARD.cols;i++){const idx=j*CHARUCO_BOARD.cols+i;if(!((parseInt(bits[idx>>2],16)>>(3-(idx&3)))&1))continue;
  const x0=-bw/2+i*gc,x1=x0+gc,y0=-bh/2+j*gr,y1=y0+gr;
  quad([x0,boardY+y0,patternZ],[x1,boardY+y0,patternZ],[x1,boardY+y1,patternZ],[x0,boardY+y1,patternZ],lit([.05,.05,.06]));}
 box([0,ribbonY,ribbonZ],[bw*.92,7,1.8],STRIPE);
 // Camera geometry the dimensions and the field of view both reference.
 const lens=[0,62*sinT+camPos[1],62*cosT+camPos[2]];
 const camDir=[0,sinT,cosT], camRight=[1,0,0], camUp=[0,-cosT,sinT];
 const tanH=(manifest.width||1920)/2/(manifest.fx||1665), tanV=(manifest.height||1080)/2/(manifest.fy||manifest.fx||1665);
 const tBoard=(boardFront-lens[2])/camDir[2];
 // Two dimensions, drawn as a thin line with end ticks and solid end markers so
 // the start and end points read in the scene. Values are millimetres.
 const DIM=[.95,.82,.3], headCentre=[0,-baseline/2,beamerZ], objectPin=[0,boardY,boardFront];
 const ruler=(a,b)=>cylinder(a,b,1.6,8,DIM), endTick=(p,size)=>box(p,size,DIM), baseX=-96;
 ruler([baseX,camPos[1],beamerZ],[baseX,laserOrigin[1],beamerZ]);
 ruler([baseX,camPos[1],beamerZ],[camPos[0],camPos[1],beamerZ]);
 ruler([baseX,laserOrigin[1],beamerZ],[laserOrigin[0],laserOrigin[1],beamerZ]);
 endTick([baseX,camPos[1],beamerZ],[16,2.6,2.6]);endTick([baseX,laserOrigin[1],beamerZ],[16,2.6,2.6]);
 ruler(headCentre,objectPin);endTick(headCentre,[16,2.6,2.6]);endTick(objectPin,[16,2.6,2.6]);
 box(headCentre,[9,9,9],DIM);box(objectPin,[9,9,9],DIM);
 // Short callout stubs joining each value tag to its dimension line.
 ruler([baseX,-baseline/2,beamerZ],[baseX-30,-baseline/2,beamerZ]);
 ruler([0,-baseline/2,(beamerZ+boardFront)/2],[96,-baseline/2,(beamerZ+boardFront)/2]);
 const opaque=out.length/10;
 // Sheet: the fan from the aperture to the projected line. Spawned from the
 // beamer principal axis, so the axis is exactly on this plane.
 const sheetThickness=6, fanHalf=bw*.46, fanStart=out.length;
 const sheetEdge0=[-fanHalf,ribbonY,ribbonZ],sheetEdge1=[fanHalf,ribbonY,ribbonZ];
 tri(aperture,sheetEdge0,sheetEdge1,LASER);
 // A plane with no thickness vanishes when a preset looks straight along it —
 // the side preset does exactly that — so the fan keeps a thin rim: its three
 // edges extruded by the sheet's own thickness. Face-on views draw the triangle
 // exactly as before; edge-on views see the rim as the sheet's edge.
 {const n=norm(cross(sub(sheetEdge0,aperture),sub(sheetEdge1,aperture))),o=n.map(v=>v*sheetThickness/2);
  const rim=(a,b)=>{const ah=a.map((v,i)=>v+o[i]),bh=b.map((v,i)=>v+o[i]),al=a.map((v,i)=>v-o[i]),bl=b.map((v,i)=>v-o[i]);quad(ah,bh,bl,al,LASER);};
  rim(aperture,sheetEdge0);rim(sheetEdge0,sheetEdge1);rim(sheetEdge1,aperture);}
 fans=(out.length-fanStart)/10;
 // Camera field of view: a translucent frustum from the lens along the optical
 // axis, half-angles from the delivered intrinsics atan((w/2)/fx).
 // Camera field of view: a pyramid from the lens itself, so the volume is
 // attached to the camera instead of floating in front of it. Half-angles come
 // from the delivered intrinsics atan((w/2)/fx); the far cap is where the
 // optical axis meets the board.
 const tFar=tBoard*1.08;
 const corner=(t,sx,sy)=>[lens[0]+t*camDir[0]+t*tanH*sx*camRight[0]+t*tanV*sy*camUp[0],lens[1]+t*camDir[1]+t*tanH*sx*camRight[1]+t*tanV*sy*camUp[1],lens[2]+t*camDir[2]+t*tanH*sx*camRight[2]+t*tanV*sy*camUp[2]];
 const fovStart=out.length;
 const f00=corner(tFar,-1,-1),f10=corner(tFar,1,-1),f11=corner(tFar,1,1),f01=corner(tFar,-1,1);
 tri(lens,f10,f00,FOV);tri(lens,f11,f10,FOV);tri(lens,f01,f11,FOV);tri(lens,f00,f01,FOV);quad(f00,f10,f11,f01,FOV);
 fov=(out.length-fovStart)/10;
 const rigEnd=out.length;
 // Frame the head and board, not the studio floor.
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(let i=rigStart;i<rigEnd;i+=10)for(let k=0;k<3;k++){const v=out[i+k];if(v<min[k])min[k]=v;if(v>max[k])max[k]=v;}
 const center=min.map((v,i)=>(v+max[i])/2),extent=max.map((v,i)=>v-min[i]),radius=(Math.max(...extent)/2||1)*1.4;
 return {vertices:new Float32Array(out),opaque,fan:fans,fov,sheetThickness,center,radius,angle:tilt*180/Math.PI,baseline,distance,
  laserColor:LASER,stripeColor:STRIPE,filterOn:FILTER_ON,filterColor:FILTER,fovColour:FOV,
  laserAxis:{origin:laserOrigin,direction:beamDir},
  cameraFov:{apex:lens,axis:camDir,halfTan:[tanH,tanV]},
  dimensions:[
   {id:'baseline',value:baseline,start:camPos,end:laserOrigin,at:[baseX-30,-baseline/2,beamerZ]},
   {id:'object',value:Math.hypot(...objectPin.map((v,k)=>v-headCentre[k])),start:headCentre,end:objectPin,at:[96,-baseline/2,(beamerZ+boardFront)/2]}
  ]};
}
