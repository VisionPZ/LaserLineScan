// SPDX-License-Identifier: GPL-3.0-or-later

/** Measured point-cloud viewer. Lighting normals and the optional wireframe
 * grid are derived only from adjacent recovered samples; no reference mesh is loaded. */
export class ScanViewer{
 constructor(canvas,labelRoot=null){
  this.canvas=canvas;this.labelRoot=labelRoot;this.labels=labelRoot?Object.fromEntries(['x','y','z'].map(a=>[a,labelRoot.querySelector('[data-axis='+a+']')])):null;this.gl=canvas.getContext('webgl',{antialias:true,alpha:true,preserveDrawingBuffer:true});if(!this.gl)throw new Error('browserError');
  const gl=this.gl;this.index32=gl.getExtension('OES_element_index_uint');
  const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  this.program=gl.createProgram();
  gl.attachShader(this.program,shader(gl.VERTEX_SHADER,`attribute vec4 point;attribute vec3 normal;attribute vec3 rgb;uniform vec3 center;uniform float radius;uniform vec4 view;uniform vec2 pan;uniform float aspect;uniform vec2 range;uniform float colorMode;uniform float errorScale;uniform float grid;uniform float mesh;uniform float box;uniform float corner;uniform float scene;varying vec3 color;
   vec3 rotate(vec3 p){float x=cos(view.x)*p.x+sin(view.x)*p.z;float z=-sin(view.x)*p.x+cos(view.x)*p.z;return vec3(x,cos(view.y)*p.y-sin(view.y)*z,sin(view.y)*p.y+cos(view.y)*z);}
   void main(){vec3 p=(point.xyz-center)/radius;p.y=-p.y;p.z=-p.z;p=rotate(p);gl_Position=vec4(p.x*view.z/aspect+pan.x,p.y*view.z+pan.y,p.z/8.0,1.0);gl_PointSize=view.w;
    float t=clamp((point.z-range.x)/max(.001,range.y-range.x),0.0,1.0);vec3 low=mix(vec3(.40,1.,.83),vec3(.19,.67,1.),smoothstep(0.,.7,t));color=mix(low,vec3(.67,.53,1.),smoothstep(.6,1.,t));
    if(colorMode>1.5){float e=clamp(point.w/errorScale,0.,1.);color=point.w<0.?vec3(.5,.57,.65):mix(vec3(.25,.92,.70),vec3(1.,.37,.32),e);}else if(colorMode>.5){color=pow(rgb,vec3(.7));}
    vec3 n=rotate(normal*vec3(1.,-1.,-1.));float light=.57+.43*abs(dot(normalize(n),normalize(vec3(-.3,.65,.85))));color*=light;if(grid>.5)color=vec3(.18,.28,.36);if(mesh>.5)color=vec3(.34,.88,1.);if(box>.5)color=vec3(1.,.83,.18);if(corner>.5){color=vec3(1.,.24,.18);gl_PointSize=view.w*2.6;}if(scene>.5){vec3 h=normalize(normalize(vec3(-.3,.65,.85))+vec3(0.,0.,1.));color+=vec3(pow(max(dot(normalize(n),h),0.),24.)*.5);}
   }`));
  gl.attachShader(this.program,shader(gl.FRAGMENT_SHADER,`precision mediump float;uniform float splat;uniform float uAlpha;varying vec3 color;void main(){float alpha=1.;if(splat>.5){float r=length(gl_PointCoord*2.-1.);if(r>1.)discard;alpha=1.-smoothstep(.65,1.,r);}gl_FragColor=vec4(color,alpha*uAlpha);}`));
  gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error('browserError');
  this.locations={};for(const name of ['center','radius','view','pan','aspect','range','colorMode','errorScale','grid','mesh','box','corner','scene','uAlpha','splat'])this.locations[name]=gl.getUniformLocation(this.program,name);
  this.attributes={};for(const name of ['point','normal','rgb'])this.attributes[name]=gl.getAttribLocation(this.program,name);
  this.pointBuffer=gl.createBuffer();this.gridBuffer=gl.createBuffer();this.edgeBuffer=gl.createBuffer();this.boxBuffer=gl.createBuffer();this.cornerBuffer=gl.createBuffer();this.count=0;this.gridCount=0;this.edgeCount=0;this.boxCount=0;this.cornerCount=0;this.sceneCount=0;this.fanStart=0;this.fanCount=0;this.fovStart=0;this.fovCount=0;this.mode='points';this.color='depth';this.pointSize=2.5;this.center=[0,0,0];this.radius=1;this.range=[0,1];this.errorScale=1;this.active=false;this.autoOrbit=false;this.showBox=true;this.reveal=1;this.animation=null;this.dimensions=[];this.dimNodes=[];this.dimRoot=document.createElement('div');this.dimRoot.className='ll-dim-labels';this.dimRoot.setAttribute('aria-hidden','true');if(canvas.parentElement)canvas.parentElement.appendChild(this.dimRoot);
  // Orientation gizmo: three coloured axes with cone arrowheads, drawn in the
  // plot corner and rotated with the cloud.
  this.gizmoProgram=gl.createProgram();
  gl.attachShader(this.gizmoProgram,shader(gl.VERTEX_SHADER,`attribute vec3 axis;attribute vec3 axisColor;uniform vec4 gview;uniform vec2 goffset;uniform float gscale;uniform float gaspect;varying vec3 color;
   vec3 rotate(vec3 p){float x=cos(gview.x)*p.x+sin(gview.x)*p.z;float z=-sin(gview.x)*p.x+cos(gview.x)*p.z;return vec3(x,cos(gview.y)*p.y-sin(gview.y)*z,sin(gview.y)*p.y+cos(gview.y)*z);}
   void main(){vec3 p=rotate(vec3(axis.x,-axis.y,-axis.z));color=axisColor;gl_Position=vec4(goffset.x+p.x*gscale/gaspect,goffset.y+p.y*gscale,0.0,1.0);}`));
  gl.attachShader(this.gizmoProgram,shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 color;void main(){gl_FragColor=vec4(color,1.0);}'));
  gl.linkProgram(this.gizmoProgram);if(!gl.getProgramParameter(this.gizmoProgram,gl.LINK_STATUS))throw new Error('browserError');
  this.gizmoLocations={};for(const name of ['gview','goffset','gscale','gaspect'])this.gizmoLocations[name]=gl.getUniformLocation(this.gizmoProgram,name);
  this.gizmoAttributes={axis:gl.getAttribLocation(this.gizmoProgram,'axis'),color:gl.getAttribLocation(this.gizmoProgram,'axisColor')};
  this.gizmoLineBuffer=gl.createBuffer();this.gizmoConeBuffer=gl.createBuffer();
  const axes=[[[1,0,0],[1,.26,.26]],[[0,1,0],[.32,1,.46]],[[0,0,1],[.38,.62,1.]]],lineData=[],coneData=[],seg=6,base=.78,rim=.075;
  for(const [dir,color] of axes)lineData.push(0,0,0,...color,dir[0],dir[1],dir[2],...color);
  axes.forEach(([dir,color],i)=>{const a=(i+1)%3,b=(i+2)%3;
   const ring=t=>[base*dir[0]+rim*(Math.cos(t)*(a===0?1:0)+Math.sin(t)*(b===0?1:0)),base*dir[1]+rim*(Math.cos(t)*(a===1?1:0)+Math.sin(t)*(b===1?1:0)),base*dir[2]+rim*(Math.cos(t)*(a===2?1:0)+Math.sin(t)*(b===2?1:0))];
   for(let k=0;k<seg;k++){const p0=ring(k/seg*Math.PI*2),p1=ring((k+1)/seg*Math.PI*2),c=dir.map(v=>v*base);coneData.push(...dir,...color,...p0,...color,...p1,...color,c[0],c[1],c[2],...color,...p1,...color,...p0,...color);}
  });
  this.gizmoLineCount=6;this.gizmoConeCount=coneData.length/6;this.gizmoX=.72;this.gizmoY=.68;this.gizmoScale=.17;
  gl.bindBuffer(gl.ARRAY_BUFFER,this.gizmoLineBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(lineData),gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.gizmoConeBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(coneData),gl.STATIC_DRAW);
  this.reset();this.bind();this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(canvas);
 }
 setLabels(show){if(this.labels)for(const s of Object.values(this.labels))s.style.visibility=show?'visible':'hidden';}
 reset(preset='iso'){this.yaw=preset==='front'?0:preset==='top'?0:preset==='side'?Math.PI/2:.30;this.pitch=preset==='front'?0:preset==='top'?-Math.PI/2:-.52;this.zoom=1.1;this.pan=[0,0];this.draw();}
 clear(){this.count=0;this.edgeCount=0;this.boxCount=0;this.cornerCount=0;this.sceneCount=0;this.fanCount=0;this.fovCount=0;this.dimensions=[];this.dimNodes.forEach(n=>n.remove());this.dimNodes=[];this.rows=[];this.result=null;this.packed=null;this.canvas.dataset.points='0';this.setLabels(false);this.draw();}
 setActive(value){this.active=value;if(value){this.draw();this.animate();}else{cancelAnimationFrame(this.animation);this.animation=null;}}
 orbit(value){this.autoOrbit=value;this.animate();}
 animate(){
  if(this.animation||!this.active||(!this.autoOrbit&&this.reveal>=1))return;
  let previous=performance.now();
  const tick=now=>{if(!this.active){this.animation=null;return;}const dt=Math.min(50,now-previous);previous=now;if(this.autoOrbit)this.yaw+=dt*.00015;if(this.reveal<1)this.reveal=Math.min(1,this.reveal+dt/1200);this.draw();if(this.autoOrbit||this.reveal<1)this.animation=requestAnimationFrame(tick);else this.animation=null;};
  this.animation=requestAnimationFrame(tick);
 }
 setCloud(result,preset='iso'){
  this.result=result;const {points,errors,observations,colors}=result,gl=this.gl,n=errors.length;
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<points.length;i++){const k=i%3;min[k]=Math.min(min[k],points[i]);max[k]=Math.max(max[k],points[i]);}
  this.extent=max.map((v,i)=>v-min[i]);this.center=min.map((v,i)=>(v+max[i])/2);this.radius=Math.max(...this.extent)/2||1;this.range=[min[2],max[2]];this.errorScale=Math.max((result.metrics.rmse||1)*3,.01);
  const width=result.manifest.width,frames=new Map();this.rows=[];this.rowOf=new Uint16Array(n);
  observations.forEach((o,i)=>{if(!frames.has(o.frame)){const row=new Int32Array(width);row.fill(-1);frames.set(o.frame,this.rows.length);this.rows.push(row);}const r=frames.get(o.frame);this.rows[r][Math.floor(o.u)]=i;this.rowOf[i]=r;});
  const packed=this.packed=new Float32Array(n*10),limit=this.radius*.09;
  for(let i=0;i<n;i++){
   packed.set(points.subarray(i*3,i*3+3),i*10);packed[i*10+3]=errors[i];packed.set([0,0,-1],i*10+4);
   if(colors?.length)packed.set(colors.subarray(i*3,i*3+3),i*10+7);
   const x=Math.floor(observations[i].u),r=this.rowOf[i],a=this.rows[r][Math.min(width-1,x+2)],b=this.rows[Math.min(this.rows.length-1,r+1)][x];
   if(a<0||b<0||a===i||b===i)continue;
   const u=[0,1,2].map(k=>points[a*3+k]-points[i*3+k]),v=[0,1,2].map(k=>points[b*3+k]-points[i*3+k]);
   if(Math.hypot(...u)>limit||Math.hypot(...v)>limit)continue;
   const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...normal);
   if(length>1e-8)packed.set(normal.map(v=>v/length*(normal[2]>0?-1:1)),i*10+4);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER,this.pointBuffer);gl.bufferData(gl.ARRAY_BUFFER,packed,gl.STATIC_DRAW);this.count=n;this.meshBuilt=false;
  // A dimensional reference grid, never part of the measured point cloud.
  const grid=[],floor=max[1]+this.radius*.2;
  for(let i=-5;i<=5;i++){
   const offset=i*this.radius*.3;
   for(const point of [[this.center[0]+offset,floor,this.center[2]-this.radius*1.5],[this.center[0]+offset,floor,this.center[2]+this.radius*1.5],[this.center[0]-this.radius*1.5,floor,this.center[2]+offset],[this.center[0]+this.radius*1.5,floor,this.center[2]+offset]])grid.push(...point,-1,0,-1,0,0,0,0);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER,this.gridBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(grid),gl.STATIC_DRAW);this.gridCount=grid.length/10;
  // Bounding box: a yellow wireframe with a red dot on every vertex.
  const corner=[];for(let i=0;i<8;i++)corner.push(i&1?max[0]:min[0],i&2?max[1]:min[1],i&4?max[2]:min[2],0,0,0,0,0,0,0);
  const box=[];for(const [a,b] of [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]])for(const c of [a,b])box.push(corner[c*10],corner[c*10+1],corner[c*10+2],0,0,0,0,0,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.boxBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(box),gl.STATIC_DRAW);this.boxCount=box.length/10;
  gl.bindBuffer(gl.ARRAY_BUFFER,this.cornerBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(corner),gl.STATIC_DRAW);this.cornerCount=8;
  this.canvas.dataset.points=String(n);this.reveal=matchMedia('(prefers-reduced-motion: reduce)').matches?1:0;this.reset(preset);this.animate();
 }
 setScene(vertices,opaqueCount,fanCount,fovCount,frame){
  const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.pointBuffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
  this.sceneCount=opaqueCount;this.fanStart=opaqueCount;this.fanCount=fanCount;this.fovStart=opaqueCount+fanCount;this.fovCount=fovCount;this.count=0;this.edgeCount=0;this.boxCount=0;this.cornerCount=0;this.meshBuilt=true;this.mode='scene';this.color='rgb';this.reveal=1;
  this.center=frame.center;this.radius=frame.radius;this.range=[frame.center[2]-frame.radius,frame.center[2]+frame.radius];this.errorScale=1;
  this.canvas.dataset.scene=String(opaqueCount+fanCount+fovCount);
  // Rebuilding the scene for a redesigned illumination must not disturb the
  // camera the user has set up.
  if(frame&&frame.keepView){this.draw();if(this.autoOrbit)this.animate();return;}
  this.reset('iso');this.animate();
 }
 setDimensions(list){
  this.dimensions=list||[];
  while(this.dimNodes.length<this.dimensions.length){const span=document.createElement('span');this.dimRoot.appendChild(span);this.dimNodes.push(span);}
  while(this.dimNodes.length>this.dimensions.length)this.dimNodes.pop().remove();
  this.dimensions.forEach((d,i)=>{const node=this.dimNodes[i];if(node.textContent!==d.text)node.textContent=d.text;if(d.title&&node.title!==d.title)node.title=d.title;});
  this.draw();
 }
 mesh(){
  this.meshBuilt=true;if(!this.index32||this.result.scanTopology!=='ordered-horizontal')return;
  const points=this.result.points,limit=this.radius*.12,bridge=this.radius*.3,fillColumns=48;
  // Vertex-based wireframe: each recovered vertex links to its horizontal and
  // vertical neighbours. A gap of up to fillColumns (an unlit occlusion shadow)
  // is bridged when the surface step is small, so the grid shows a continuous
  // surface without adding measured points.
  const edges=new Uint32Array(this.count*4);let edgeCount=0;
  const link=(a,b,max)=>{if(a<0||b<0)return;if(Math.hypot(points[a*3]-points[b*3],points[a*3+1]-points[b*3+1],points[a*3+2]-points[b*3+2])>max)return;edges[edgeCount++]=a;edges[edgeCount++]=b;};
  for(let r=0;r<this.rows.length;r++){
   let last=-1,lastColumn=-1;
   for(let x=0;x<this.rows[r].length;x++){
    const v=this.rows[r][x];if(v<0)continue;
    if(last>=0&&x-lastColumn<=fillColumns)link(last,v,bridge);
    last=v;lastColumn=x;
   }
   if(r<this.rows.length-1)for(let x=0;x<this.rows[r].length;x++)link(this.rows[r][x],this.rows[r+1][x],limit);
  }
  this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER,this.edgeBuffer);this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER,edges.subarray(0,edgeCount),this.gl.STATIC_DRAW);this.edgeCount=edgeCount;this.canvas.dataset.meshEdges=String(edgeCount/2);
 }
 bindBuffer(buffer){const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,buffer);for(const [name,size,offset]of [['point',4,0],['normal',3,16],['rgb',3,28]]){const a=this.attributes[name];gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,size,gl.FLOAT,false,40,offset);}}
 draw(){
  const gl=this.gl;if(!gl||!this.program)return;const ratio=Math.min(2,devicePixelRatio||1),w=Math.round(this.canvas.clientWidth*ratio),h=Math.round(this.canvas.clientHeight*ratio);if(!w||!h)return;
  if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
  gl.viewport(0,0,w,h);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);if(!this.count&&!this.sceneCount)return;
  gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.useProgram(this.program);const u=this.locations;
  gl.uniform3fv(u.center,this.center);gl.uniform1f(u.radius,this.radius);gl.uniform4f(u.view,this.yaw,this.pitch,this.zoom*Math.min(1,w/h*.82),this.pointSize*ratio);gl.uniform2fv(u.pan,this.pan);gl.uniform1f(u.aspect,w/h);gl.uniform2fv(u.range,this.range);gl.uniform1f(u.colorMode,this.color==='error'?2:this.color==='rgb'?1:0);gl.uniform1f(u.errorScale,this.errorScale);gl.uniform1f(u.scene,this.mode==='scene'?1:0);gl.uniform1f(u.uAlpha,1);
  gl.uniform1f(u.grid,1);gl.uniform1f(u.splat,0);gl.uniform1f(u.mesh,0);gl.uniform1f(u.box,0);gl.uniform1f(u.corner,0);this.bindBuffer(this.gridBuffer);gl.drawArrays(gl.LINES,0,this.gridCount);
  if(this.mode==='mesh'&&!this.meshBuilt)this.mesh();
  const scene=this.mode==='scene'&&this.sceneCount>0,mesh=this.mode==='mesh'&&this.edgeCount>0;gl.uniform1f(u.grid,0);gl.uniform1f(u.splat,scene||mesh?0:1);this.bindBuffer(this.pointBuffer);
  if(scene){gl.drawArrays(gl.TRIANGLES,0,this.sceneCount);if(this.fovCount||this.fanCount)gl.depthMask(false);if(this.fovCount){gl.uniform1f(u.uAlpha,.14);gl.drawArrays(gl.TRIANGLES,this.fovStart,this.fovCount);}if(this.fanCount){gl.uniform1f(u.uAlpha,.4);gl.drawArrays(gl.TRIANGLES,this.fanStart,this.fanCount);}gl.uniform1f(u.uAlpha,1);gl.depthMask(true);}
  else if(mesh){gl.uniform1f(u.mesh,1);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.edgeBuffer);gl.drawElements(gl.LINES,this.edgeCount,gl.UNSIGNED_INT,0);gl.uniform1f(u.mesh,0);gl.uniform1f(u.splat,1);gl.drawArrays(gl.POINTS,0,Math.floor(this.count*this.reveal));}
  else gl.drawArrays(gl.POINTS,0,Math.floor(this.count*this.reveal));
  if(this.showBox&&this.boxCount){
   gl.uniform1f(u.box,1);gl.uniform1f(u.splat,0);this.bindBuffer(this.boxBuffer);gl.drawArrays(gl.LINES,0,this.boxCount);
   gl.uniform1f(u.box,0);gl.uniform1f(u.corner,1);gl.uniform1f(u.splat,1);this.bindBuffer(this.cornerBuffer);gl.drawArrays(gl.POINTS,0,this.cornerCount);gl.uniform1f(u.corner,0);
  }
  // Re-draw the depth-cleared gizmo last so it always sits on top.
  gl.clear(gl.DEPTH_BUFFER_BIT);gl.useProgram(this.gizmoProgram);
  gl.uniform4f(this.gizmoLocations.gview,this.yaw,this.pitch,0,0);gl.uniform2f(this.gizmoLocations.goffset,this.gizmoX,this.gizmoY);gl.uniform1f(this.gizmoLocations.gscale,this.gizmoScale);gl.uniform1f(this.gizmoLocations.gaspect,w/h);
  for(const a of Object.values(this.attributes))gl.disableVertexAttribArray(a);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.gizmoLineBuffer);gl.enableVertexAttribArray(this.gizmoAttributes.axis);gl.vertexAttribPointer(this.gizmoAttributes.axis,3,gl.FLOAT,false,24,0);gl.enableVertexAttribArray(this.gizmoAttributes.color);gl.vertexAttribPointer(this.gizmoAttributes.color,3,gl.FLOAT,false,24,12);gl.drawArrays(gl.LINES,0,this.gizmoLineCount);
  gl.bindBuffer(gl.ARRAY_BUFFER,this.gizmoConeBuffer);gl.vertexAttribPointer(this.gizmoAttributes.axis,3,gl.FLOAT,false,24,0);gl.vertexAttribPointer(this.gizmoAttributes.color,3,gl.FLOAT,false,24,12);gl.drawArrays(gl.TRIANGLES,0,this.gizmoConeCount);
  gl.useProgram(this.program);
  if(this.labels){
   // X / Y / Z letters follow the projected axis tips, pushed just past the arrowheads.
   const cw=this.canvas.clientWidth||w,ch=this.canvas.clientHeight||h,aspect=cw/ch,cx=(this.gizmoX*.5+.5)*cw,cy=(.5-this.gizmoY*.5)*ch;
   const rot=p=>{const x=Math.cos(this.yaw)*p[0]+Math.sin(this.yaw)*p[2],z=-Math.sin(this.yaw)*p[0]+Math.cos(this.yaw)*p[2];return[x,Math.cos(this.pitch)*p[1]-Math.sin(this.pitch)*z,Math.sin(this.pitch)*p[1]+Math.cos(this.pitch)*z];};
   for(const [name,axis] of [['x',[1,0,0]],['y',[0,1,0]],['z',[0,0,1]]]){
    const p=rot([axis[0],-axis[1],-axis[2]]),left=((this.gizmoX+p[0]*this.gizmoScale/aspect)*.5+.5)*cw,top=(.5-(this.gizmoY+p[1]*this.gizmoScale)*.5)*ch,dx=left-cx,dy=top-cy,len=Math.hypot(dx,dy)||1;
    this.labels[name].style.left=(left+dx/len*12)+'px';this.labels[name].style.top=(top+dy/len*12)+'px';this.labels[name].style.visibility='visible';
   }
  }
  if(this.dimNodes.length){
   // Project each dimension's world anchor with the same transform as the
   // vertex shader, so the DOM label tracks the measurement as the rig turns.
   const cw=this.canvas.clientWidth||w,ch=this.canvas.clientHeight||h,aspect=cw/ch,scale=this.zoom*Math.min(1,cw/ch*.82);
   const cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cp=Math.cos(this.pitch),sp=Math.sin(this.pitch);
   this.dimensions.forEach((d,i)=>{const p=d.at;
    const qx=(p[0]-this.center[0])/this.radius,qy=-(p[1]-this.center[1])/this.radius,qz=-(p[2]-this.center[2])/this.radius;
    const rx=cy*qx+sy*qz,rz=-sy*qx+cy*qz,ry=cp*qy-sp*rz;
    const ndcX=rx*scale/aspect+this.pan[0],ndcY=ry*scale+this.pan[1],node=this.dimNodes[i];
    node.style.left=((ndcX*.5+.5)*cw)+'px';node.style.top=((.5-ndcY*.5)*ch)+'px';
    node.style.visibility=(ndcX>-1.4&&ndcX<1.4&&ndcY>-1.4&&ndcY<1.4)?'visible':'hidden';});
  }
  this.canvas.dataset.box=String(!!(this.showBox&&this.boxCount));this.canvas.dataset.gizmo=String(this.count>0||this.sceneCount>0);
  this.canvas.dataset.revealed=String(this.reveal>=1);
 }
 zoomBy(factor){this.zoom=Math.min(12,Math.max(.12,this.zoom*factor));this.draw();}
 rotateBy(degrees=45){this.yaw+=degrees*Math.PI/180;this.draw();}
 bind(){
  const c=this.canvas,pointers=new Map();c.addEventListener('contextmenu',e=>e.preventDefault());
  c.addEventListener('pointerdown',e=>{c.focus({preventScroll:true});c.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,button:e.button});});
  const gesture=()=>{const p=[...pointers.values()];return{x:p.reduce((s,v)=>s+v.x,0)/p.length,y:p.reduce((s,v)=>s+v.y,0)/p.length,d:p.length>1?Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y):0};};
  c.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const before=gesture(),old=pointers.get(e.pointerId);pointers.set(e.pointerId,{...old,x:e.clientX,y:e.clientY});const after=gesture(),dx=after.x-before.x,dy=after.y-before.y;if(pointers.size>1||old.button===2||e.shiftKey){this.pan[0]+=dx/c.clientWidth*2;this.pan[1]-=dy/c.clientHeight*2;if(before.d>5&&after.d>5)this.zoomBy(after.d/before.d);}else{this.yaw+=dx*.008;this.pitch+=dy*.008;}this.draw();});
  for(const event of ['pointerup','pointercancel','lostpointercapture'])c.addEventListener(event,e=>pointers.delete(e.pointerId));
  c.addEventListener('wheel',e=>{e.preventDefault();this.zoomBy(Math.exp(-e.deltaY*.001));},{passive:false});
  c.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(e.key))return;e.preventDefault();const step=.06;if(e.key==='Home')this.reset();else if(e.key==='+'||e.key==='=')this.zoomBy(1.1);else if(e.key==='-')this.zoomBy(1/1.1);else if(e.shiftKey){this.pan[0]+=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0;this.pan[1]+=e.key==='ArrowDown'?-step:e.key==='ArrowUp'?step:0;}else{this.yaw+=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0;this.pitch+=e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0;}this.draw();});
 }
}
