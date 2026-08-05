/**
 * WebGL2 sprite renderer.
 *
 * One texture, one shader, one draw call per frame. Every sprite is an instance in a
 * single interleaved buffer, uploaded once per frame and drawn with
 * `drawArraysInstanced`. Instances rasterise in submission order, so submitting in
 * painter's order gives correct isometric occlusion without a depth buffer.
 *
 * At 120Hz on a phone the thing that kills you is draw-call count and per-object
 * JavaScript overhead, not fill rate — hence the flat typed-array batch.
 */

import type { Atlas, Sprite } from './atlas';

const VERT = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_pos;
layout(location = 2) in vec2 a_size;
layout(location = 3) in vec4 a_uv;
layout(location = 4) in vec4 a_tint;

uniform vec4 u_transform;  // xy = scale, zw = offset

out vec2 v_uv;
out vec4 v_tint;

void main() {
  vec2 world = a_pos + a_corner * a_size;
  gl_Position = vec4(world * u_transform.xy + u_transform.zw, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_tint = a_tint;
}
`;

const FRAG = `#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_tint;
uniform sampler2D u_tex;
out vec4 outColor;

void main() {
  vec4 texel = texture(u_tex, v_uv);
  // The atlas is uploaded premultiplied, so the tint must be premultiplied too.
  outColor = texel * vec4(v_tint.rgb * v_tint.a, v_tint.a);
  if (outColor.a < 0.004) discard;
}
`;

const FLOATS_PER_INSTANCE = 12;

export class Renderer {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instanceBuffer: WebGLBuffer;
  private texture: WebGLTexture;
  private uTransform: WebGLUniformLocation;

  private data: Float32Array;
  private count = 0;
  private capacity: number;

  private atlasW = 1;
  private atlasH = 1;

  /** Viewport in CSS pixels. */
  viewW = 1;
  viewH = 1;
  dpr = 1;

  /** Draw statistics for the perf overlay. */
  lastSpriteCount = 0;

  constructor(canvas: HTMLCanvasElement, atlas: Atlas, capacity = 24000) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;

    this.capacity = capacity;
    this.data = new Float32Array(capacity * FLOATS_PER_INSTANCE);

    this.program = this.compile(VERT, FRAG);
    this.uTransform = gl.getUniformLocation(this.program, 'u_transform')!;

    // Static unit quad, drawn as a triangle strip.
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_INSTANCE * 4;
    const attrs: [number, number, number][] = [
      [1, 2, 0],   // a_pos
      [2, 2, 8],   // a_size
      [3, 4, 16],  // a_uv
      [4, 4, 32],  // a_tint
    ];
    for (const [loc, size, offset] of attrs) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    this.texture = this.uploadAtlas(atlas);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private compile(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, vsSrc);
    const fs = mk(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
  }

  private uploadAtlas(atlas: Atlas): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Canvas sources are stored premultiplied; asking for premultiplied upload avoids
    // a lossy round-trip and kills the dark fringing you otherwise get on edges.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    // No mipmaps: the atlas is tightly packed and mip bleeding between neighbouring
    // sprites is far more visible than the mild aliasing at minimum zoom.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasW = atlas.width;
    this.atlasH = atlas.height;
    return tex;
  }

  /** Resize the drawing buffer to match the element, honouring device pixel ratio. */
  resize(cssW: number, cssH: number, dpr: number): void {
    this.viewW = cssW;
    this.viewH = cssH;
    this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  begin(clear: [number, number, number]): void {
    const gl = this.gl;
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.count = 0;
  }

  /**
   * Queue a sprite.
   *
   * `x`/`y` are in world pixels (isometric screen space before the camera transform).
   * `scale` multiplies the sprite's natural size; because small art is supersampled in
   * the atlas, the sprite's own `scale` is divided out here so callers work in logical
   * pixels throughout.
   */
  draw(sp: Sprite, x: number, y: number, scale = 1, r = 1, g = 1, b = 1, a = 1): void {
    if (this.count >= this.capacity) return;
    const i = this.count * FLOATS_PER_INSTANCE;
    const d = this.data;
    const s = scale / sp.scale;
    d[i] = x - sp.ax * s;
    d[i + 1] = y - sp.ay * s;
    d[i + 2] = sp.pw * s;
    d[i + 3] = sp.ph * s;
    d[i + 4] = sp.u0 / this.atlasW;
    d[i + 5] = sp.v0 / this.atlasH;
    d[i + 6] = sp.u1 / this.atlasW;
    d[i + 7] = sp.v1 / this.atlasH;
    d[i + 8] = r;
    d[i + 9] = g;
    d[i + 10] = b;
    d[i + 11] = a;
    this.count++;
  }

  /** Queue an axis-aligned solid rectangle in world pixels (uses the white sprite). */
  drawRect(white: Sprite, x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count * FLOATS_PER_INSTANCE;
    const d = this.data;
    // Sample the middle of the white block so bilinear filtering cannot reach an edge.
    const cu = (white.u0 + white.u1) / 2 / this.atlasW;
    const cv = (white.v0 + white.v1) / 2 / this.atlasH;
    d[i] = x;
    d[i + 1] = y;
    d[i + 2] = w;
    d[i + 3] = h;
    d[i + 4] = cu;
    d[i + 5] = cv;
    d[i + 6] = cu;
    d[i + 7] = cv;
    d[i + 8] = r;
    d[i + 9] = g;
    d[i + 10] = b;
    d[i + 11] = a;
    this.count++;
  }

  /** Flush the batch with a camera at (camX, camY) world pixels and the given zoom. */
  flush(camX: number, camY: number, zoom: number): void {
    const gl = this.gl;
    if (this.count === 0) return;

    const sx = (zoom * 2) / this.viewW;
    const sy = (-zoom * 2) / this.viewH;
    const ox = -camX * sx;
    const oy = -camY * sy;

    gl.useProgram(this.program);
    gl.uniform4f(this.uTransform, sx, sy, ox, oy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * FLOATS_PER_INSTANCE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);

    this.lastSpriteCount = this.count;
    this.count = 0;
  }

  /** True once the GL context has been lost; the caller should stop rendering. */
  get contextLost(): boolean {
    return this.gl.isContextLost();
  }
}
