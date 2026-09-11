// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>

// Image-only navigation. Acquisition pixels and worker coordinates never change.
export class ImagePreview {
 constructor(stage){
  this.view=stage.querySelector('.ll-frame-view');this.image=this.view.querySelector('img');this.overlay=this.view.querySelector('canvas.ll-overlay');this.spectral=this.view.querySelector('canvas.ll-spectral-canvas');this.annotation=null;this.showRoi=false;
  this.toolbar=stage.querySelector('.ll-image-tools');this.output=this.toolbar.querySelector('output');
  this.pointers=new Map();this.reset();
  this.toolbar.addEventListener('click',event=>{
   const action=event.target.closest('[data-image-action]')?.dataset.imageAction;
   if(action==='in')this.zoom(1.25);if(action==='out')this.zoom(.8);
   if(action==='left')this.rotate(-90);if(action==='right')this.rotate(90);
   if(action==='reset')this.reset();
   if(action==='roi')this.toggleRoi();
  });
  this.view.addEventListener('wheel',event=>{
   event.preventDefault();const rect=this.view.getBoundingClientRect();
   this.zoom(Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*.003),event.clientX-rect.left-rect.width/2,event.clientY-rect.top-rect.height/2);
  },{passive:false});
  this.view.addEventListener('pointerdown',event=>{
   if(event.button!==0&&event.button!==2)return;
   event.preventDefault();this.view.focus({preventScroll:true});this.view.setPointerCapture(event.pointerId);
   this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});this.view.classList.add('is-panning');
  });
  this.view.addEventListener('pointermove',event=>{
   if(!this.pointers.has(event.pointerId))return;
   const before=[...this.pointers.values()];this.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});const after=[...this.pointers.values()];
   if(before.length===1){this.x+=after[0].x-before[0].x;this.y+=after[0].y-before[0].y;}
   else if(before.length===2){
    const midpoint=p=>({x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2});
    const length=p=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y),a=midpoint(before),b=midpoint(after),rect=this.view.getBoundingClientRect();
    this.zoom(length(after)/Math.max(1,length(before)),a.x-rect.left-rect.width/2,a.y-rect.top-rect.height/2);
    this.x+=b.x-a.x;this.y+=b.y-a.y;
   }
   this.draw();
  });
  const release=event=>{this.pointers.delete(event.pointerId);if(!this.pointers.size)this.view.classList.remove('is-panning');};
  for(const name of ['pointerup','pointercancel','lostpointercapture'])this.view.addEventListener(name,release);
  this.view.addEventListener('contextmenu',event=>event.preventDefault());
  this.view.addEventListener('dblclick',()=>this.reset());
  this.view.addEventListener('keydown',event=>{
   const step=event.shiftKey?60:20;
   if(event.key==='ArrowLeft')this.x-=step;else if(event.key==='ArrowRight')this.x+=step;
   else if(event.key==='ArrowUp')this.y-=step;else if(event.key==='ArrowDown')this.y+=step;
   else if(event.key==='+'||event.key==='=')this.zoom(1.25);else if(event.key==='-')this.zoom(.8);
   else if(event.key==='[')this.rotate(-90);else if(event.key===']')this.rotate(90);
   else if(event.key==='Home')this.reset();else return;
   event.preventDefault();this.draw();
  });
  this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(this.view);
 }
 reset(){this.scale=1;this.angle=0;this.x=0;this.y=0;this.draw();}
 annotate(annotation){this.annotation=annotation&&((annotation.ids&&annotation.ids.length)||annotation.roi)?annotation:null;this.paint();}
 paint(){
  const c=this.overlay;if(!c)return;const ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);const a=this.annotation;if(!a)return;
  if(a.roi&&this.showRoi)this.paintRoi(ctx,a.roi);
  const ids=a.ids;if(!ids||!ids.length)return;
  const pts=a.corners;
  // Detected board corners: hollow yellow circles with their ids. No connecting
  // grid lines — the corners alone locate the board and leave the image clear.
  ctx.lineWidth=3;ctx.strokeStyle='#ffd54a';ctx.fillStyle='#ffffff';ctx.font='bold 24px ui-monospace,SFMono-Regular,Menlo,monospace';ctx.textAlign='left';ctx.textBaseline='middle';
  for(let i=0;i<ids.length;i++){const x=pts[i*2],y=pts[i*2+1];ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);ctx.stroke();ctx.fillText(String(ids[i]),x+14,y);}
 }
 // The calibration-derived stripe search ROI: one [top, bottom) row interval
 // per column. Hidden until the viewer turns it on, so the captured image is
 // unobstructed by default. Near-horizontal planes read as a thin rectangle; a
 // tilted command shows the actual slanted band that is searched.
 toggleRoi(){
  const box=this.toolbar.querySelector('[data-image-action="roi"]');
  this.showRoi=box?!!box.checked:!this.showRoi;
  this.paint();
 }
 paintRoi(ctx,roi){
  const {top,bottom}=roi,n=Math.min(top?.length||0,bottom?.length||0);
  // Columns cleared by the object-box prior carry an empty band; draw only the
  // surviving run so the outline never collapses to a stray line.
  let x0=0;while(x0<n&&bottom[x0]<=top[x0])x0++;
  let x1=n-1;while(x1>x0&&bottom[x1]<=top[x1])x1--;
  if(x1-x0<2)return;
  ctx.save();ctx.lineWidth=3;ctx.strokeStyle='#2ecc71';
  ctx.beginPath();ctx.moveTo(x0+.5,top[x0]);
  for(let x=x0+1;x<=x1;x++)ctx.lineTo(x+.5,top[x]);
  for(let x=x1;x>=x0;x--)ctx.lineTo(x+.5,bottom[x]);
  ctx.closePath();ctx.stroke();ctx.restore();
 }
 zoom(factor,x=0,y=0){
  const next=Math.max(.5,Math.min(8,this.scale*factor)),ratio=next/this.scale;
  this.x=x-(x-this.x)*ratio;this.y=y-(y-this.y)*ratio;this.scale=next;this.draw();
 }
 rotate(degrees){this.angle=(this.angle+degrees+360)%360;this.draw();}
 draw(){
  const w=this.view.clientWidth,h=this.view.clientHeight;if(!w||!h)return;
  // At 100%, fit the complete image even after a quarter turn or fullscreen.
  const fit=Math.min(w/1920,h/1080),swapped=this.angle%180!==0;
  const rotatedFit=swapped?Math.min(w/1080,h/1920):fit;
  const scale=this.scale*rotatedFit/fit;
  this.x=Math.max(-w*.45,Math.min(w*.45,this.x));this.y=Math.max(-h*.45,Math.min(h*.45,this.y));
  this.image.style.transform=`translate(${this.x}px,${this.y}px) rotate(${this.angle}deg) scale(${scale})`;
  if(this.overlay)this.overlay.style.transform=this.image.style.transform;
  // The spectral re-render sits under the annotation and follows the same
  // pan / zoom / rotate transform as the reference image.
  if(this.spectral)this.spectral.style.transform=this.image.style.transform;
  this.output.value=`${Math.round(this.scale*100)}%`;
  this.view.dataset.zoom=String(this.scale);this.view.dataset.rotation=String(this.angle);
  this.view.dataset.panX=String(this.x);this.view.dataset.panY=String(this.y);
  this.toolbar.querySelector('[data-image-action="in"]').disabled=this.scale>=8;
  this.toolbar.querySelector('[data-image-action="out"]').disabled=this.scale<=.5;
  this.paint();
 }
}
