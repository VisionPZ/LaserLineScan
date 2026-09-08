// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Ping Zhao <ping.zhao@nidvue.com>

/* GPU layers for the spectral design tool.
 *
 * `applySpectralFrame` re-renders a reference capture with the designed
 * illumination. It prefers WebGPU, falls back to WebGL2 and reports 'cpu' when
 * neither is available; the caller then uses applySpectral() from spectral.js.
 * `drawSpectrum` plots the designed laser line, the filter passband, the
 * ambient and the sensor response on a WebGL2 canvas.
 */

import {applySpectral, transformSpec} from './spectral.js';

const VERTEX = `#version 300 es
in vec2 aPos;
void main(){gl_Position=vec4(aPos,0.0,1.0);}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform float uAmbient,uLaser,uFocal,uMaxAngle,uCx,uCy;
uniform vec3 uStripe;
uniform vec3 uTint;
uniform float uCurve[91];
uniform vec2 uSize;
out vec4 outColor;
void main(){
 vec2 uv=gl_FragCoord.xy/uSize;
 vec3 rgb=texture(uImage,uv).rgb;
 float s=max(0.0,rgb.b-max(rgb.r,rgb.g));
 vec3 base=rgb-s*vec3(0.015,0.12,1.0);
 float dx=gl_FragCoord.x-uCx,dy=(uSize.y-gl_FragCoord.y)-uCy;
 float deg=degrees(atan(length(vec2(dx,dy)),uFocal));
 float t=clamp(deg/uMaxAngle,0.0,1.0)*90.0;
 int i0=int(min(floor(t),89.0)),i1=min(i0+1,90);
 float gain=mix(uCurve[i0],uCurve[i1],t-float(i0));
 // Ambient-lit surfaces and the self-luminous stripe follow the model term.
 outColor=vec4(clamp(base*uAmbient*uTint+s*uLaser*gain*uStripe,0.0,1.0),1.0);
}`;

/* ---------------------------------------------------------------- engine */

export function spectralEngine() {
  if (typeof navigator !== 'undefined' && navigator.gpu) return 'webgpu';
  if (typeof document !== 'undefined' && document.createElement('canvas').getContext('webgl2')) return 'webgl2';
  return 'cpu';
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
  return shader;
}

function program(gl, vertex, fragment) {
  const out = gl.createProgram();
  gl.attachShader(out, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(out, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(out);
  if (!gl.getProgramParameter(out, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(out) || 'link');
  return out;
}

/* ---------------------------------------------------------------- transform */

let webgl = null;

function webgl2Transform(source, spec) {
  const {width, height} = spec;
  if (!webgl) {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true});
    if (!gl) return null;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const transform = program(gl, VERTEX, FRAGMENT);
    const texture = gl.createTexture();
    webgl = {canvas, gl, quad, transform, texture, width: 0, height: 0};
  }
  const {gl} = webgl;
  if (webgl.width !== width || webgl.height !== height) {
    webgl.canvas.width = width;
    webgl.canvas.height = height;
    webgl.width = width;
    webgl.height = height;
  }
  gl.viewport(0, 0, width, height);
  gl.useProgram(webgl.transform);
  const pos = gl.getAttribLocation(webgl.transform, 'aPos');
  gl.bindBuffer(gl.ARRAY_BUFFER, webgl.quad);
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, webgl.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(webgl.transform, 'uImage'), 0);
  gl.uniform1f(gl.getUniformLocation(webgl.transform, 'uAmbient'), spec.ambient);
  gl.uniform1f(gl.getUniformLocation(webgl.transform, 'uLaser'), spec.laser);
  gl.uniform1f(gl.getUniformLocation(webgl.transform, 'uFocal'), spec.focal);
  gl.uniform1f(gl.getUniformLocation(webgl.transform, 'uMaxAngle'), spec.maxAngle);
  gl.uniform1f(gl.getUniformLocation(webgl.transform, 'uCx'), spec.cx);
  gl.uniform1f(gl.getUniformLocation(webgl.transform, 'uCy'), spec.cy);
  gl.uniform2f(gl.getUniformLocation(webgl.transform, 'uSize'), width, height);
  gl.uniform3fv(gl.getUniformLocation(webgl.transform, 'uStripe'), new Float32Array(spec.color));
  gl.uniform3fv(gl.getUniformLocation(webgl.transform, 'uTint'), new Float32Array(spec.tint || [1, 1, 1]));
  gl.uniform1fv(gl.getUniformLocation(webgl.transform, 'uCurve'), new Float32Array(spec.curve));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return webgl.canvas;
}

let webgpu = null;

const WGSL = `
struct Uniforms {
 ambient: f32, laser: f32, focal: f32, maxAngle: f32,
 cx: f32, cy: f32, width: f32, height: f32,
 stripe: vec3f, pad: f32,
 tint: vec3f, pad2: f32,
 // Uniform arrays are 16-byte strided, so the 91 curve samples ride in vec4
 // slots (23 x 16 B) and the shader unpacks the two neighbours it mixes.
 // This also rounds the struct up to 432 B; the buffer must be that large.
 curve: array<vec4f, 23>,
};
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
 var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
 return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
 let uv = frag.xy / vec2f(u.width, u.height);
 let rgb = textureSample(src, samp, uv).rgb;
 let s = max(0.0, rgb.b - max(rgb.r, rgb.g));
 let base = rgb - s * vec3f(0.015, 0.12, 1.0);
 let dx = frag.x - u.cx;
 let dy = frag.y - u.cy;
 let deg = degrees(atan2(length(vec2f(dx, dy)), u.focal));
 let t = clamp(deg / u.maxAngle, 0.0, 1.0) * 90.0;
 let i0 = u32(min(floor(t), 89.0));
 let j = min(i0 + 1u, 90u);
 let c0 = u.curve[i0 / 4u][i0 % 4u];
 let c1 = u.curve[j / 4u][j % 4u];
 let gain = mix(c0, c1, t - floor(t));
 let outRgb = base * u.ambient * u.tint + s * u.laser * gain * u.stripe;
 return vec4f(clamp(outRgb, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

async function initWebgpu() {
  if (webgpu !== null) return webgpu;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return (webgpu = false);
    const device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const module = device.createShaderModule({code: WGSL});
    const compiled = await module.getCompilationInfo();
    if (compiled.messages.some(m => m.type === 'error')) return (webgpu = false);
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {module, entryPoint: 'vs'},
      fragment: {module, entryPoint: 'fs', targets: [{format: navigator.gpu.getPreferredCanvasFormat()}]},
      primitive: {topology: 'triangle-list'},
    });
    if (await device.popErrorScope()) return (webgpu = false);
    const sampler = device.createSampler({minFilter: 'nearest', magFilter: 'nearest'});
    webgpu = {device, pipeline, sampler, canvas: null, context: null, buffer: null,
      canvas: document.createElement('canvas')};
  } catch { webgpu = false; }
  return webgpu;
}

async function webgpuTransform(source, spec) {
  const gpu = await initWebgpu();
  if (!gpu) return null;
  const {canvas} = gpu;
  if (canvas.width !== spec.width || canvas.height !== spec.height) {
    canvas.width = spec.width;
    canvas.height = spec.height;
  }
  if (!gpu.context) gpu.context = canvas.getContext('webgpu');
  if (!gpu.configured) {
    gpu.context.configure({device: gpu.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque'});
    gpu.configured = true;
  }
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const texture = gpu.device.createTexture({
    size: [spec.width, spec.height, 1], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  gpu.device.queue.copyExternalImageToTexture({source: bitmap}, {texture}, [spec.width, spec.height]);
  if (source !== bitmap) bitmap.close();
  // 16 scalar uniforms + 92 curve floats in 23 vec4 slots = 432 B, the exact
  // size the WGSL struct rounds up to; a short buffer invalidates the bind
  // group and WebGPU skips the draw, leaving the canvas black.
  if (!gpu.buffer) gpu.buffer = gpu.device.createBuffer({size: (16 + 92) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
  const data = new Float32Array(16 + 92);
  data.set([spec.ambient, spec.laser, spec.focal, spec.maxAngle, spec.cx, spec.cy, spec.width, spec.height], 0);
  data.set([spec.color[0], spec.color[1], spec.color[2], 0], 8);
  data.set([spec.tint[0], spec.tint[1], spec.tint[2], 0], 12);
  for (let i = 0; i < 91; i++) data[16 + i] = spec.curve[i];
  data[16 + 91] = spec.curve[90];
  gpu.device.queue.writeBuffer(gpu.buffer, 0, data);
  gpu.device.pushErrorScope('validation');
  const bind = gpu.device.createBindGroup({
    layout: gpu.pipeline.getBindGroupLayout(0),
    entries: [
      {binding: 0, resource: texture.createView()},
      {binding: 1, resource: gpu.sampler},
      {binding: 2, resource: {buffer: gpu.buffer}},
    ],
  });
  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{view: gpu.context.getCurrentTexture().createView(),
      clearValue: {r: 0, g: 0, b: 0, a: 1}, loadOp: 'clear', storeOp: 'store'}],
  });
  pass.setPipeline(gpu.pipeline);
  pass.setBindGroup(0, bind);
  pass.draw(3);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
  texture.destroy();
  // A validation error (short buffer, bad bind group, lost device...) makes
  // WebGPU skip the draw and leave the canvas at its black clear value, so
  // surface it here and let the caller fall back to the WebGL2 path.
  const failure = await gpu.device.popErrorScope();
  if (failure) {
    console.warn('laser webgpu transform failed: ' + failure.message);
    return null;
  }
  return canvas;
}

/**
 * Render `source` for the designed illumination. Returns {canvas, engine} or
 * null when the caller must fall back to the CPU path.
 */
export async function applySpectralFrame(source, model, geometry, mode = 'filtered') {
  const spec = transformSpec(model, geometry, mode);
  if (typeof document === 'undefined') return null;
  if (navigator.gpu) {
    try { const canvas = await webgpuTransform(source, spec); if (canvas) return {canvas, engine: 'webgpu'}; }
    catch { webgpu = null; }
  }
  try { const canvas = webgl2Transform(source, spec); if (canvas) return {canvas, engine: 'webgl2'}; }
  catch { webgl = null; }
  return null;
}

export function applySpectralCpu(imageData, model, geometry, mode = 'filtered') {
  return applySpectral(imageData.data, transformSpec(model, geometry, mode));
}
