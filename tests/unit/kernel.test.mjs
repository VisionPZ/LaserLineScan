// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>
/*
 * The open WebAssembly laser kernel (runtime/core.wasm): reference / plane
 * fitting, the stripe-extraction estimators and sub-pixel accuracy.
 * Ported from the parent repository's tests/laser-kernel.test.mjs.
 */
// Tests for the open laser kernel (assembly/laser/oss.ts -> runtime/core.wasm,
// GPL-3.0-or-later): classical Steger/Hessian extraction and camera/laser
// calibration. The out-of-band verification tests live in verify.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {instance}=await WebAssembly.instantiate(readFileSync(new URL('../../runtime/core.wasm', import.meta.url)),{env:{abort(){throw new Error('abort');}}});
const w=instance.exports;
const fit=()=>Array.from(new Float64Array(w.memory.buffer,w.resultPtr(),6));
test('translating reference fit recovers plane tilt, offset and travel',()=>{
 w.reset();for(let i=0;i<100;i++)for(let j=0;j<10;j++){const t=i/99,z=3.5+j*.08,y=.7+2.7*t-.55*z;w.addReference(z,y,t);}
 assert.equal(w.fit(.005,0,0),1);const f=fit();for(const [a,b]of [[f[0],.55],[f[1],.7],[f[2],2.7]])assert.ok(Math.abs(a-b)<1e-7);
 const z=4,t=.6,v=224+690*((.7+2.7*t)/z-.55);assert.ok(Math.abs(w.depth(v,t,690,224)-z)<1e-7);
});
test('fixed laser is recovered from points on varied board planes',()=>{
 w.reset();for(let i=0;i<100;i++)for(let j=0;j<10;j++){const x=-1+j*.2,z=3.4+i*.01,y=-1.845+.45*z-.02*x;w.addPlanePoint(x,y,z);}
 assert.equal(w.fitPlane(.005,0,0,0,0),1);const f=fit();assert.ok(Math.abs(f[0]-.02)<1e-7);assert.ok(Math.abs(f[1]+.45)<1e-7);assert.ok(Math.abs(f[2]+1.845)<1e-7);
});
test('one fixed board identifies a plane only with the known emitter constraint',()=>{
 w.reset();const emitter=[0,-1.8,.1],nx=.2,nz=-.45,d=-1.845,z=4;
 for(let i=0;i<200;i++){const x=-1+i*.01,y=d-nx*x-nz*z;w.addPlanePoint(x,y,z);}
 assert.equal(w.fitPlane(.005,0,0,0,0),0,'single planar stripe cannot solve an unconstrained plane');
 assert.equal(w.fitPlane(.005,1,...emitter),1);const f=fit();assert.ok(Math.abs(f[0]-nx)<1e-7);assert.ok(Math.abs(f[1]-nz)<1e-7);
});
test('blank and threshold-rejected images produce no stripe',()=>{
 new Uint8Array(w.memory.buffer,w.inputPtr(),640*448*4).fill(0);
 assert.equal(w.extract(0,.98,40,0,1),0);assert.equal(w.extract(1,.98,255,0,1),0);
 w.reset();assert.equal(w.fit(.005,0,0),0);assert.equal(w.fitPlane(.005,0,0,0,0),0);
});
test('subpixel peak detects a known Gaussian laser profile',()=>{
 const buffer=new Uint8Array(w.memory.buffer,w.inputPtr(),640*448*4);
 for(let y=0;y<448;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;buffer[i]=30;buffer[i+1]=30;buffer[i+2]=Math.round(30+140*Math.exp(-.5*((y-170.25)/1.2)**2));buffer[i+3]=255;}
 const n=w.extract(0,.98,40,0,.8);assert.ok(n>500);
 const stripe=new Float64Array(w.memory.buffer,w.stripePtr(),n*3);assert.ok(Math.abs(stripe[1]-170.75)<.08,'returns boundary-origin pixel coordinates');
});
test('hessian ridge estimator returns the sub-pixel centre',()=>{
 const buffer=new Uint8Array(w.memory.buffer,w.inputPtr(),640*448*4);
 for(let y=0;y<448;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;buffer[i]=30;buffer[i+1]=30;buffer[i+2]=Math.round(30+140*Math.exp(-.5*((y-170.25)/1.2)**2));buffer[i+3]=255;}
 const n=w.extract(0,.98,40,3,.8);assert.ok(n>500);
 const stripe=new Float64Array(w.memory.buffer,w.stripePtr(),n*3);assert.ok(Math.abs(stripe[1]-170.75)<.05,'hessian ridge is sub-pixel');
});
test('hessian ridge tracks a slanted notebook stripe sub-pixel',()=>{
 const buffer=new Uint8Array(w.memory.buffer,w.inputPtr(),640*448*4);
 for(let y=0;y<448;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;const centre=170+.2*(x-320);buffer[i]=30;buffer[i+1]=30;buffer[i+2]=Math.round(30+150*Math.exp(-.5*((y-centre)/1.2)**2));buffer[i+3]=255;}
 const n=w.extract(0,.98,40,3,.8);assert.ok(n>400);
 const stripe=new Float64Array(w.memory.buffer,w.stripePtr(),n*3);
 let sum=0,count=0;
 for(let k=0;k<n;k++){const x=stripe[k*3];if(x>200&&x<440){const e=stripe[k*3+1]-(170+.2*(x-320)+.5);sum+=e*e;count++;}}
 assert.ok(count>100);assert.ok(Math.sqrt(sum/count)<.15,'slanted ridge stays sub-pixel');
});
test('hessian ridge falls back to the quadratic peak on a saturated stripe',()=>{
 const buffer=new Uint8Array(w.memory.buffer,w.inputPtr(),640*448*4);
 for(let y=0;y<448;y++)for(let x=0;x<640;x++){const i=(y*640+x)*4;const value=Math.min(255,Math.round(30+320*Math.exp(-.5*((y-170.25)/1.2)**2)));buffer[i]=30;buffer[i+1]=30;buffer[i+2]=value;buffer[i+3]=255;}
 const ridge=w.extract(0,.98,40,3,.8),quadratic=w.extract(0,.98,40,0,.8);
 assert.ok(quadratic>0&&ridge>=Math.floor(quadratic*.98),`ridge ${ridge} vs quadratic ${quadratic}`);
});
