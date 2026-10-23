/**
 * The ground, drawn in one pass.
 *
 * Terrain used to be ten thousand diamond sprites, and however carefully each was
 * painted the eye read the seams: the land looked like graph paper. Pharaoh's land is a
 * single painted surface — sand runs into black soil runs into the river, and the
 * shoreline wanders. This pass gets that by rendering the ground per pixel from the
 * terrain grid instead of per tile:
 *
 *  - The grid is uploaded as an N×N data texture (type, fertility, flood, height).
 *  - Each pixel blends the four nearest tiles, with the lookup warped by noise so
 *    boundaries meander instead of following the diagonal.
 *  - All texture detail is sampled in world space, so there is nothing to line up.
 *  - Water is composited separately from land so the shore is crisp, with wet sand on
 *    one side and a foam line on the other.
 *  - Roads are painted here too, from their own unwarped blend, so a run of road is one
 *    continuous worn track with rounded junctions rather than a row of tiles.
 *
 * One draw call, a 40 KB texture, and it holds at any zoom.
 */

import { TILE_W, TILE_H } from './atlas';
import type { World } from './world';

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_tiles;
uniform vec4 u_xf;      // world = (frag.x * x + y, frag.y * z + w)
uniform float u_n;      // map size in tiles
uniform float u_time;
uniform float u_zoom;   // world-to-device pixels, for detail falloff
uniform vec3 u_light;
uniform float u_grid;   // 0..1 placement grid
uniform vec3 u_back;
out vec4 outColor;

// ---------------------------------------------------------------- noise
// Baked, tileable and mipmapped: one texture read per sample, and the mip chain does
// the anti-aliasing that would otherwise make the ground shimmer at low zoom.
//   r, g  broad fbm (two seeds)     b  close value noise     a  near-white grain
uniform sampler2D u_noise;
vec4 nz(vec2 p) { return texture(u_noise, p); }

// ---------------------------------------------------------------- terrain

const float WATER = 0.0, FLOODPLAIN = 1.0, DESERT = 2.0, DUNE = 3.0, ROCK = 4.0, MARSH = 5.0, GRASS = 6.0;

vec4 tileAt(ivec2 c) {
  int n = int(u_n) - 1;
  return texelFetch(u_tiles, clamp(c, ivec2(0), ivec2(n)), 0);
}

// Land colour for one terrain type at a world position. 'fine' fades the highest
// frequencies out as the camera pulls back, so zooming out does not shimmer.
vec3 landColor(float t, float fert, vec2 w, float mott, float grain, float speck, float fine) {
  vec3 c;

  if (t == DESERT) {
    c = mix(vec3(0.88, 0.76, 0.56), vec3(0.95, 0.85, 0.66), mott);
    c *= 0.94 + 0.10 * grain * fine;
    if (speck > 0.985) c *= mix(1.0, 0.78, fine);        // pebbles
    if (speck < 0.012) c *= mix(1.0, 1.12, fine);
  } else if (t == DUNE) {
    vec2 d = normalize(vec2(1.0, 0.35));
    float ripple = sin(dot(w, d) / 6.0 + nz(w / 600.0).g * 9.0);
    c = mix(vec3(0.93, 0.82, 0.62), vec3(0.99, 0.90, 0.72), mott);
    c *= 1.0 + ripple * 0.045 * fine;
    c *= 0.96 + 0.06 * grain * fine;
  } else if (t == GRASS) {
    vec3 sand = vec3(0.80, 0.72, 0.50);
    vec3 green = vec3(0.58, 0.64, 0.34);
    c = mix(sand, green, smoothstep(0.3, 0.7, mott + grain * 0.25));
    if (speck > 0.93) c = mix(c, vec3(0.44, 0.52, 0.25), 0.7 * fine);   // tufts
  } else if (t == FLOODPLAIN) {
    // Kemet: the black land. Richer and greener where the silt is deep.
    vec3 dry = vec3(0.62, 0.56, 0.37);
    vec3 rich = vec3(0.40, 0.45, 0.23);
    c = mix(dry, rich, clamp(fert, 0.0, 1.0));
    c *= 0.86 + 0.26 * mott;
    c *= 0.92 + 0.16 * grain * fine;
    if (speck > 0.90) c = mix(c, vec3(0.45, 0.56, 0.24), 0.55 * fine);  // green shoots
    if (speck < 0.06) c *= mix(1.0, 0.84, fine);                        // damp clods
  } else if (t == MARSH) {
    c = mix(vec3(0.42, 0.50, 0.31), vec3(0.51, 0.57, 0.36), mott);
    float pool = smoothstep(0.56, 0.62, nz(w / 380.0 + 0.37).r);
    c = mix(c, vec3(0.28, 0.44, 0.43), pool * 0.85);
    c *= 0.95 + 0.08 * grain * fine;
  } else if (t == ROCK) {
    c = mix(vec3(0.68, 0.62, 0.52), vec3(0.81, 0.75, 0.64), mott);
    // Fractured stone: thin dark seams where the noise crosses its midpoint.
    float seam = abs(nz(w / 160.0 + 0.11).b - 0.5);
    c *= mix(1.0, 0.72, (1.0 - smoothstep(0.0, 0.035, seam)) * fine);
    c *= 0.92 + 0.14 * grain * fine;
  } else {
    c = vec3(0.80, 0.67, 0.48);
  }
  return c;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 w = vec2(frag.x * u_xf.x + u_xf.y, frag.y * u_xf.z + u_xf.w);

  // World pixels to fractional tile coordinates (inverse of the 2:1 projection).
  float a = w.x / ${(TILE_W / 2).toFixed(1)};
  float b = w.y / ${(TILE_H / 2).toFixed(1)};
  vec2 t = vec2((b + a) * 0.5, (b - a) * 0.5);

  float fine = smoothstep(0.3, 0.9, u_zoom);

  vec4 broad = nz(w / 900.0);   // r,g: large patches and the edge warp
  // Mottling at two scales: one bigger than the screen, one that shows within it.
  float mott = mix(broad.r, nz(w / 240.0 + 0.13).g, 0.55);
  // The texture is 256 texels across, so a sample at w / S has features of roughly
  // S / (cells per channel) world pixels: grain ~10 px, speck ~2-4 px.
  float grain = nz(w / 160.0).b;
  float speck = nz(w / 512.0 + 0.37).a;

  // Warp the lookup so edges between terrains meander rather than run along the grid.
  // Two octaves: the broad one bends coastlines, the finer one scrambles the one-tile
  // staircase that a blend of square cells otherwise leaves along every diagonal edge.
  vec2 warp = (nz(w / 520.0 + 0.5).rg - 0.5) * 1.5 + (nz(w / 190.0 + 0.27).gr - 0.5) * 0.7;
  vec2 p = t - 0.5 + warp;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);

  vec4 d00 = tileAt(i0);
  vec4 d10 = tileAt(i0 + ivec2(1, 0));
  vec4 d01 = tileAt(i0 + ivec2(0, 1));
  vec4 d11 = tileAt(i0 + ivec2(1, 1));

  float w00 = (1.0 - s.x) * (1.0 - s.y);
  float w10 = s.x * (1.0 - s.y);
  float w01 = (1.0 - s.x) * s.y;
  float w11 = s.x * s.y;

  float t00 = floor(d00.r * 255.0 + 0.5);
  float t10 = floor(d10.r * 255.0 + 0.5);
  float t01 = floor(d01.r * 255.0 + 0.5);
  float t11 = floor(d11.r * 255.0 + 0.5);

  // How much of this pixel is river, and how much is flooded field.
  float wf = w00 * float(t00 == WATER) + w10 * float(t10 == WATER)
           + w01 * float(t01 == WATER) + w11 * float(t11 == WATER);
  float ff = w00 * d00.b + w10 * d10.b + w01 * d01.b + w11 * d11.b;

  // Land is blended only across land tiles, with sharpened weights so neighbouring
  // terrains meet in a soft band rather than a muddy tile-wide smear.
  vec3 land = vec3(0.0);
  float lw = 0.0;
  float k;
  k = pow(w00, 1.3) * float(t00 != WATER); land += k * landColor(t00, d00.g, w, mott, grain, speck, fine); lw += k;
  k = pow(w10, 1.3) * float(t10 != WATER); land += k * landColor(t10, d10.g, w, mott, grain, speck, fine); lw += k;
  k = pow(w01, 1.3) * float(t01 != WATER); land += k * landColor(t01, d01.g, w, mott, grain, speck, fine); lw += k;
  k = pow(w11, 1.3) * float(t11 != WATER); land += k * landColor(t11, d11.g, w, mott, grain, speck, fine); lw += k;
  // A pixel deep in the river still needs a bed colour for the shallows.
  land = lw > 0.0001 ? land / lw : vec3(0.66, 0.60, 0.43);

  // ---- river
  float edgeNoise = (nz(w / 130.0 + 0.23).b - 0.5) * 0.12;
  float shore = wf + edgeNoise;
  float waterMask = smoothstep(0.47, 0.53, shore);

  // Wet sand on the land side of the waterline.
  float wet = smoothstep(0.18, 0.5, shore) * (1.0 - waterMask);
  land *= 1.0 - 0.28 * wet;

  vec2 flow = vec2(u_time * 9.0, u_time * 4.0);
  float rip1 = nz((w + flow) / 110.0).b;
  float rip2 = nz((w - flow * 0.7) / 170.0 + 0.5).b;
  float depth = smoothstep(0.5, 0.95, shore);
  vec3 shallow = vec3(0.36, 0.62, 0.63);
  vec3 deep = vec3(0.19, 0.43, 0.53);
  vec3 river = mix(shallow, deep, depth);
  river *= 0.92 + 0.16 * (rip1 * 0.6 + rip2 * 0.4);
  // Sun glints on the broad water.
  float glint = smoothstep(0.86, 0.95, rip1 * rip2 * 1.6) * depth;
  river += vec3(0.30, 0.32, 0.28) * glint * fine;
  // Foam where the water breaks against the bank.
  float foam = (1.0 - smoothstep(0.50, 0.60, shore)) * waterMask;
  foam *= 0.55 + 0.45 * nz((w + flow * 0.5) / 50.0).b;
  river = mix(river, vec3(0.86, 0.88, 0.80), foam * 0.75);

  vec3 col = mix(land, river, waterMask);

  // ---- the inundation: silty, shallow, translucent over the black land
  float floodMask = smoothstep(0.35, 0.6, ff + edgeNoise) * (1.0 - waterMask);
  if (floodMask > 0.0) {
    vec3 silt = vec3(0.44, 0.56, 0.53);
    silt *= 0.92 + 0.14 * (rip1 * 0.5 + rip2 * 0.5);
    col = mix(col, silt, floodMask * 0.86);
  }

  // ---- roads: their own blend, unwarped, so they follow the grid the walkers use
  {
    vec2 q = t - 0.5;
    ivec2 r0 = ivec2(floor(q));
    vec2 rf = fract(q);
    vec2 rs = rf * rf * (3.0 - 2.0 * rf);
    vec4 a00 = tileAt(r0), a10 = tileAt(r0 + ivec2(1, 0));
    vec4 a01 = tileAt(r0 + ivec2(0, 1)), a11 = tileAt(r0 + ivec2(1, 1));
    float q00 = (1.0 - rs.x) * (1.0 - rs.y), q10 = rs.x * (1.0 - rs.y);
    float q01 = (1.0 - rs.x) * rs.y, q11 = rs.x * rs.y;
    float road = q00 * step(0.25, a00.a) + q10 * step(0.25, a10.a)
               + q01 * step(0.25, a01.a) + q11 * step(0.25, a11.a);
    float paved = q00 * step(0.75, a00.a) + q10 * step(0.75, a10.a)
                + q01 * step(0.75, a01.a) + q11 * step(0.75, a11.a);
    // A tile exactly at a road tile's centre scores 1; the edge of the track sits at
    // about a third, which makes it nearly a full tile wide with a soft, worn margin.
    float rn = (nz(w / 75.0 + 0.71).b - 0.5) * 0.06;
    float rmask = smoothstep(0.26, 0.36, road + rn);
    float verge = smoothstep(0.12, 0.30, road + rn) * (1.0 - rmask);
    // Trampled ground just off the track.
    col *= 1.0 - 0.14 * verge * (1.0 - waterMask);
    // Compacted earth: browner and darker than the sand around it, paler down the
    // middle where feet and carts have worn it smooth, with a defined darker margin.
    vec3 dirt = vec3(0.70, 0.57, 0.39);
    float crown = smoothstep(0.45, 0.85, road);
    dirt = mix(dirt, vec3(0.78, 0.66, 0.47), crown * 0.8);
    dirt *= 0.93 + 0.12 * nz(w / 220.0 + 0.3).b;
    dirt *= 0.97 + 0.06 * speck * fine;
    float edgeDark = 1.0 - smoothstep(0.30, 0.42, road);
    dirt *= 1.0 - 0.22 * edgeDark;
    vec3 stone = vec3(0.86, 0.82, 0.72);
    vec2 cell = fract(t * vec2(3.0, 3.0) + vec2(0.0, floor(t.x * 3.0) * 0.5));
    float joint = max(smoothstep(0.90, 0.97, cell.x), smoothstep(0.90, 0.97, cell.y));
    stone *= 1.0 - 0.18 * joint;
    stone *= 0.95 + 0.08 * nz(w / 40.0).b;
    vec3 surface = mix(dirt, stone, smoothstep(0.3, 0.6, paved / max(road, 0.001)));
    col = mix(col, surface, rmask * (1.0 - waterMask));
  }

  // ---- placement grid, only while a building is armed
  if (u_grid > 0.0) {
    vec2 g = abs(fract(t) - 0.5);
    float line = smoothstep(0.482, 0.5, max(g.x, g.y));
    col *= 1.0 - 0.14 * line * u_grid;
  }

  col *= u_light;

  // ---- the edge of the world: fade to dark rather than stopping on a hard diagonal
  float outside = max(max(-t.x, t.x - u_n), max(-t.y, t.y - u_n));
  col = mix(col, u_back, smoothstep(0.0, 3.0, outside));

  outColor = vec4(col, 1.0);
}
`;

/**
 * A 256² tileable noise texture, built once. Each channel is periodic over the texture
 * so it repeats seamlessly, and the four are used at unrelated scales in the shader so
 * no repeat lines up with another.
 */
function makeNoise(): Uint8Array {
  const N = 256;
  const out = new Uint8Array(N * N * 4);
  const hash = (x: number, y: number, seed: number): number => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  };
  // Value noise with `cells` lattice cells across the texture, wrapping at the edge.
  const value = (x: number, y: number, cells: number, seed: number): number => {
    const fx = (x / N) * cells;
    const fy = (y / N) * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const ux = tx * tx * (3 - 2 * tx);
    const uy = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => hash(((i % cells) + cells) % cells, ((j % cells) + cells) % cells, seed);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
  };
  const fbm = (x: number, y: number, base: number, seed: number): number => {
    let sum = 0, amp = 0.5, norm = 0, cells = base;
    for (let o = 0; o < 5; o++) {
      sum += amp * value(x, y, cells, seed + o * 31);
      norm += amp;
      amp *= 0.5;
      cells *= 2;
    }
    return sum / norm;
  };

  const ch = [new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N), new Float32Array(N * N)];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      ch[0][i] = fbm(x, y, 4, 11);
      ch[1][i] = fbm(x, y, 4, 97);
      ch[2][i] = fbm(x, y, 16, 203) * 0.7 + value(x, y, 64, 7) * 0.3;
      ch[3][i] = value(x, y, 128, 59) * 0.6 + hash(x, y, 3) * 0.4;
    }
  }
  // Stretch each channel to the full range so the shader's thresholds mean something.
  for (let c = 0; c < 4; c++) {
    let lo = 1, hi = 0;
    for (const v of ch[c]) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const k = 1 / Math.max(1e-6, hi - lo);
    for (let i = 0; i < N * N; i++) out[i * 4 + c] = Math.round((ch[c][i] - lo) * k * 255);
  }
  return out;
}

export class GroundPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private tex: WebGLTexture;
  private noise: WebGLTexture;
  private data: Uint8Array;
  private size = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private uploadTimer = 0;
  private uploadedVersion = -1;
  private uploadedWorld: World | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = this.compile(VERT, FRAG);
    for (const name of ['u_noise', 'u_tiles', 'u_xf', 'u_n', 'u_time', 'u_zoom', 'u_light', 'u_grid', 'u_back']) {
      this.u[name] = gl.getUniformLocation(this.program, name);
    }
    this.vao = gl.createVertexArray()!;
    this.tex = gl.createTexture()!;
    this.data = new Uint8Array(0);

    this.noise = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, makeNoise());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private compile(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('Ground shader failed: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Ground program failed: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  /**
   * Refresh the terrain texture. The grid only changes on flood, silt and fertility
   * draw-down, so it is re-sent when the world says so, and otherwise at most twice a
   * second as a backstop — 40 KB, which is nothing.
   */
  private upload(world: World, dt: number, pavedAt?: (i: number) => boolean): void {
    const gl = this.gl;
    this.uploadTimer += dt;
    const n = world.size;
    const changed = world !== this.uploadedWorld || world.groundVersion !== this.uploadedVersion;
    if (this.size === n && !changed && this.uploadTimer < 0.5) return;
    this.uploadTimer = 0;
    this.uploadedVersion = world.groundVersion;
    this.uploadedWorld = world;

    if (this.data.length !== n * n * 4) this.data = new Uint8Array(n * n * 4);
    const d = this.data;
    for (let i = 0; i < n * n; i++) {
      const o = i * 4;
      d[o] = world.terrain[i];
      d[o + 1] = Math.min(255, Math.round((world.fertility[i] / 100) * 255));
      d[o + 2] = world.flooded[i] ? 255 : 0;
      d[o + 3] = world.road[i] ? (pavedAt?.(i) ? 255 : 128) : 0;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this.size !== n) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.size = n;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, d);
    }
  }

  draw(opts: {
    world: World; camX: number; camY: number; zoom: number;
    viewW: number; viewH: number; canvasH: number; dpr: number;
    time: number; dt: number; light: number[]; grid: number; back: number[];
    pavedAt?: (i: number) => boolean;
  }): void {
    const gl = this.gl;
    this.upload(opts.world, opts.dt, opts.pavedAt);

    // Device pixel to world pixel. GL's fragment origin is bottom-left.
    const s = 1 / (opts.dpr * opts.zoom);
    const xf: [number, number, number, number] = [
      s, opts.camX - opts.viewW / (2 * opts.zoom),
      -s, opts.camY + (opts.canvasH / opts.dpr) / (2 * opts.zoom),
    ];

    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.u_tiles, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.uniform1i(this.u.u_noise, 2);
    gl.uniform4f(this.u.u_xf, xf[0], xf[1], xf[2], xf[3]);
    gl.uniform1f(this.u.u_n, opts.world.size);
    gl.uniform1f(this.u.u_time, opts.time % 1000);
    gl.uniform1f(this.u.u_zoom, opts.zoom * opts.dpr);
    gl.uniform3f(this.u.u_light, opts.light[0], opts.light[1], opts.light[2]);
    gl.uniform1f(this.u.u_grid, opts.grid);
    gl.uniform3f(this.u.u_back, opts.back[0], opts.back[1], opts.back[2]);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
  }
}
