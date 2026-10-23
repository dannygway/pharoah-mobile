/**
 * Procedural sprite atlas.
 *
 * Every pixel in this game is drawn at boot into a single texture atlas on a 2D canvas.
 * That keeps the download tiny (there are no image assets at all), makes the whole look
 * tweakable from code, and means one texture bind serves the entire scene.
 *
 * The atlas is packed with a simple shelf packer at a fixed width; the height grows to
 * the next power of two that fits.
 */

import { RNG, hashStr, clamp } from './core';
import { BUILDINGS, BuildingDef, ArtStyle, GOD_IDS, GODS } from './data';

/** Logical tile size in CSS pixels at zoom 1. */
export const TILE_W = 64;
export const TILE_H = 32;

export interface Sprite {
  /** Atlas rect in texels. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pixel size of the sprite in atlas texels. */
  pw: number;
  ph: number;
  /** Supersampling factor this sprite was drawn at. */
  scale: number;
  /** Where the tile-diamond's top corner sits inside the sprite, in atlas texels. */
  ax: number;
  ay: number;
}

export interface Atlas {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  sprites: Map<string, Sprite>;
  get(name: string): Sprite;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3
    ? h.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [v[0] || 0, v[1] || 0, v[2] || 0];
}

function rgbStr(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(clamp(r, 0, 255))},${Math.round(clamp(g, 0, 255))},${Math.round(clamp(b, 0, 255))},${a})`;
}

/** Multiply a hex colour's brightness. */
export function shade(hex: string, mul: number, a = 1): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbStr(r * mul, g * mul, b * mul, a);
}

/** Blend two hex colours. */
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbStr(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

// ---------------------------------------------------------------------------
// Packer
// ---------------------------------------------------------------------------

interface PackJob {
  name: string;
  w: number;
  h: number;
  scale: number;
  ax: number;
  ay: number;
  draw: (ctx: CanvasRenderingContext2D, ox: number, oy: number) => void;
}

const ATLAS_WIDTH = 2048;
const PAD = 2;

function pack(jobs: PackJob[], onProgress?: (f: number) => void): Atlas {
  // Tallest first gives a much tighter shelf packing.
  const sorted = [...jobs].sort((a, b) => b.h - a.h);

  let x = PAD;
  let y = PAD;
  let shelfH = 0;
  const placed: { job: PackJob; x: number; y: number }[] = [];

  for (const job of sorted) {
    if (x + job.w + PAD > ATLAS_WIDTH) {
      x = PAD;
      y += shelfH + PAD;
      shelfH = 0;
    }
    placed.push({ job, x, y });
    x += job.w + PAD;
    shelfH = Math.max(shelfH, job.h);
  }
  const needed = y + shelfH + PAD;
  let height = 256;
  while (height < needed) height *= 2;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true })!;
  ctx.imageSmoothingEnabled = true;

  const sprites = new Map<string, Sprite>();
  let n = 0;
  for (const p of placed) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x, p.y, p.job.w, p.job.h);
    ctx.clip();
    ctx.translate(p.x, p.y);
    p.job.draw(ctx, 0, 0);
    ctx.restore();
    sprites.set(p.job.name, {
      u0: p.x, v0: p.y, u1: p.x + p.job.w, v1: p.y + p.job.h,
      pw: p.job.w, ph: p.job.h, scale: p.job.scale,
      ax: p.job.ax, ay: p.job.ay,
    });
    if (onProgress && ++n % 20 === 0) onProgress(n / placed.length);
  }

  const missing: Sprite = { u0: 0, v0: 0, u1: 1, v1: 1, pw: 1, ph: 1, scale: 1, ax: 0, ay: 0 };
  return {
    canvas, width: ATLAS_WIDTH, height, sprites,
    get(name: string) {
      return sprites.get(name) ?? missing;
    },
  };
}

// ---------------------------------------------------------------------------
// Isometric drawing primitives
// ---------------------------------------------------------------------------

/** Path an isometric diamond covering `s` x `s` tiles, top corner at (ox, oy). */
function diamondPath(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number): void {
  const hw = (s * tw) / 2;
  const hh = (s * th) / 2;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(ox + hw, oy + hh);
  ctx.lineTo(ox, oy + hh * 2);
  ctx.lineTo(ox - hw, oy + hh);
  ctx.closePath();
}

/**
 * Draw an isometric box: the two visible vertical faces plus the top.
 * (ox, oy) is the top corner of the *base* diamond; the box rises `h` pixels.
 */
function isoBox(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, s: number, h: number,
  top: string, left: string, right: string,
  tw = TILE_W, th = TILE_H,
): void {
  const hw = (s * tw) / 2;
  const hh = (s * th) / 2;
  const T = [ox, oy];
  const R = [ox + hw, oy + hh];
  const B = [ox, oy + hh * 2];
  const L = [ox - hw, oy + hh];

  // Right (south-east) face.
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(B[0], B[1]);
  ctx.lineTo(R[0], R[1]);
  ctx.lineTo(R[0], R[1] - h);
  ctx.lineTo(B[0], B[1] - h);
  ctx.closePath();
  ctx.fill();

  // Left (south-west) face.
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(L[0], L[1]);
  ctx.lineTo(B[0], B[1]);
  ctx.lineTo(B[0], B[1] - h);
  ctx.lineTo(L[0], L[1] - h);
  ctx.closePath();
  ctx.fill();

  // Top face.
  ctx.fillStyle = top;
  diamondPath(ctx, ox, oy - h, s, tw, th);
  ctx.fill();
}

/** A tapering box, used for pylons, pyramids and obelisks. */
function isoTaper(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, s: number, h: number, topScale: number,
  top: string, left: string, right: string,
  tw = TILE_W, th = TILE_H,
): void {
  const hw = (s * tw) / 2;
  const hh = (s * th) / 2;
  const thw = hw * topScale;
  const thh = hh * topScale;
  const cx = ox;
  const cy = oy + hh;

  const B = [ox, oy + hh * 2];
  const R = [ox + hw, oy + hh];
  const L = [ox - hw, oy + hh];
  const tB = [cx, cy + thh - h];
  const tR = [cx + thw, cy - h];
  const tL = [cx - thw, cy - h];

  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(B[0], B[1]);
  ctx.lineTo(R[0], R[1]);
  ctx.lineTo(tR[0], tR[1]);
  ctx.lineTo(tB[0], tB[1]);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(L[0], L[1]);
  ctx.lineTo(B[0], B[1]);
  ctx.lineTo(tB[0], tB[1]);
  ctx.lineTo(tL[0], tL[1]);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.moveTo(cx, cy - thh - h);
  ctx.lineTo(tR[0], tR[1]);
  ctx.lineTo(tB[0], tB[1]);
  ctx.lineTo(tL[0], tL[1]);
  ctx.closePath();
  ctx.fill();
}

/** Speckle a region with soft noise to break up flat fills. */
function speckle(ctx: CanvasRenderingContext2D, rng: RNG, x: number, y: number, w: number, h: number, n: number, colors: string[]): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[rng.int(colors.length)];
    const px = x + rng.next() * w;
    const py = y + rng.next() * h;
    const r = 0.6 + rng.next() * 1.6;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Soft contact shadow under a structure. */
function groundShadow(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number): void {
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#2b1d10';
  diamondPath(ctx, ox + tw * 0.06, oy + th * 0.12, s, tw, th);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------




// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Natural features
// ---------------------------------------------------------------------------

function drawPalm(ctx: CanvasRenderingContext2D, sc: number, variant: number): void {
  const rng = new RNG(9001 + variant * 31);
  const tw = TILE_W * sc;
  const cx = tw / 2;
  const baseY = TILE_H * sc;
  const h = (34 + rng.float(0, 14)) * sc;

  ctx.strokeStyle = '#7a5f38';
  ctx.lineWidth = 2.6 * sc;
  ctx.lineCap = 'round';
  const lean = rng.float(-4, 4) * sc;
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.quadraticCurveTo(cx + lean * 0.5, baseY - h * 0.6, cx + lean, baseY - h);
  ctx.stroke();

  // Fronds.
  const fronds = 7;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * Math.PI * 2 + rng.float(-0.2, 0.2);
    const len = (12 + rng.float(0, 7)) * sc;
    ctx.strokeStyle = i % 2 ? '#4e7c3a' : '#5f8f45';
    ctx.lineWidth = 2.2 * sc;
    ctx.beginPath();
    ctx.moveTo(cx + lean, baseY - h);
    ctx.quadraticCurveTo(
      cx + lean + Math.cos(a) * len * 0.6, baseY - h + Math.sin(a) * len * 0.3 - 3 * sc,
      cx + lean + Math.cos(a) * len, baseY - h + Math.sin(a) * len * 0.5 + 3 * sc,
    );
    ctx.stroke();
  }
  // Dates.
  ctx.fillStyle = '#b5763f';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(cx + lean + rng.float(-3, 3) * sc, baseY - h + rng.float(1, 4) * sc, 1.3 * sc, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawAcacia(ctx: CanvasRenderingContext2D, sc: number, variant: number): void {
  const rng = new RNG(7777 + variant * 53);
  const tw = TILE_W * sc;
  const cx = tw / 2;
  const baseY = TILE_H * sc;
  const h = (20 + rng.float(0, 8)) * sc;

  ctx.strokeStyle = '#6b5334';
  ctx.lineWidth = 2.4 * sc;
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx + rng.float(-2, 2) * sc, baseY - h);
  ctx.stroke();

  // Flat-topped canopy.
  ctx.fillStyle = '#6f8a45';
  ctx.beginPath();
  ctx.ellipse(cx, baseY - h - 3 * sc, 13 * sc, 5.5 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#83a054';
  ctx.beginPath();
  ctx.ellipse(cx - 2 * sc, baseY - h - 5 * sc, 9 * sc, 3.6 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawReeds(ctx: CanvasRenderingContext2D, sc: number, variant: number): void {
  const rng = new RNG(5150 + variant * 97);
  const tw = TILE_W * sc;
  const baseY = TILE_H * sc;
  for (let i = 0; i < 16; i++) {
    const x = tw * 0.2 + rng.next() * tw * 0.6;
    const h = (10 + rng.next() * 14) * sc;
    ctx.strokeStyle = rng.chance(0.5) ? '#6f8a45' : '#87a05a';
    ctx.lineWidth = 1.2 * sc;
    ctx.beginPath();
    ctx.moveTo(x, baseY - rng.next() * 4 * sc);
    ctx.quadraticCurveTo(x + rng.float(-3, 3) * sc, baseY - h * 0.6, x + rng.float(-5, 5) * sc, baseY - h);
    ctx.stroke();
    // Papyrus head.
    if (rng.chance(0.5)) {
      ctx.fillStyle = '#a8b06a';
      ctx.beginPath();
      ctx.arc(x + rng.float(-4, 4) * sc, baseY - h, 2 * sc, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawBoulder(ctx: CanvasRenderingContext2D, sc: number, variant: number): void {
  const rng = new RNG(3131 + variant * 17);
  const tw = TILE_W * sc;
  const cx = tw / 2;
  const baseY = TILE_H * sc * 0.85;
  ctx.fillStyle = '#8d7f6d';
  ctx.beginPath();
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = (7 + rng.float(0, 5)) * sc;
    const px = cx + Math.cos(a) * r;
    const py = baseY - 4 * sc + Math.sin(a) * r * 0.55;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#a89a86';
  ctx.beginPath();
  ctx.ellipse(cx - 2 * sc, baseY - 7 * sc, 5 * sc, 2.6 * sc, -0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawBush(ctx: CanvasRenderingContext2D, sc: number, variant: number): void {
  const rng = new RNG(1919 + variant * 23);
  const tw = TILE_W * sc;
  const cx = tw / 2;
  const baseY = TILE_H * sc * 0.9;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = rng.chance(0.5) ? '#6a7f3c' : '#7d9349';
    ctx.beginPath();
    ctx.arc(cx + rng.float(-6, 6) * sc, baseY - rng.float(1, 6) * sc, rng.float(3, 5.5) * sc, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

/** Extra vertical room a style needs above its nominal height. */
function styleHeadroom(style: ArtStyle, h: number): number {
  switch (style) {
    case 'monument': return h + 40;
    case 'temple': return h + 26;
    case 'tower': return h + 20;
    default: return h + 22;
  }
}

function drawBuilding(ctx: CanvasRenderingContext2D, def: BuildingDef, sc: number, level = -1): void {
  const s = def.size;
  const tw = TILE_W * sc;
  const th = TILE_H * sc;
  const h = def.art.height * sc;
  const headroom = styleHeadroom(def.art.style, h);
  const ox = (s * tw) / 2;
  const oy = headroom;
  const rng = new RNG(hashStr(def.id) + level * 977);

  const base = def.art.base;
  const roof = def.art.roof;
  const accent = def.art.accent ?? mix(base, '#ffffff', 0.3);

  groundShadow(ctx, ox, oy, s, tw, th);

  switch (def.art.style) {
    case 'road':
      drawFlatPlatform(ctx, ox, oy, s, tw, th, base, roof);
      if (def.id === 'roadblock') drawRoadblock(ctx, ox, oy, tw, th, sc);
      if (def.id === 'festival_square') drawFestivalSquare(ctx, ox, oy, s, tw, th, sc, rng);
      break;
    case 'garden':
      drawGarden(ctx, ox, oy, s, tw, th, sc, rng);
      break;
    case 'farm':
      drawFarm(ctx, ox, oy, s, tw, th, sc, rng, def);
      break;
    case 'mine':
      drawMine(ctx, ox, oy, s, tw, th, sc, rng, def);
      break;
    case 'water':
      drawWharf(ctx, ox, oy, s, tw, th, sc, rng, def);
      break;
    case 'reed':
      drawReedStructure(ctx, ox, oy, s, tw, th, h, sc, rng, base, roof);
      break;
    case 'temple':
      drawTemple(ctx, ox, oy, s, tw, th, h, sc, rng, def);
      break;
    case 'monument':
      drawMonument(ctx, ox, oy, s, tw, th, h, sc, rng, def);
      break;
    case 'tower':
      drawTower(ctx, ox, oy, s, tw, th, h, sc, rng, def);
      break;
    case 'house':
      drawHouse(ctx, ox, oy, tw, th, sc, rng, level);
      break;
    case 'stone':
      drawStoneBuilding(ctx, ox, oy, s, tw, th, h, sc, rng, base, roof, accent);
      break;
    case 'mud':
    default:
      drawMudBuilding(ctx, ox, oy, s, tw, th, h, sc, rng, base, roof, accent);
      break;
  }
}

function drawFlatPlatform(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, base: string, roof: string): void {
  diamondPath(ctx, ox, oy, s, tw, th);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.strokeStyle = shade(base, 0.8, 0.5);
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawRoadblock(ctx: CanvasRenderingContext2D, ox: number, oy: number, tw: number, th: number, sc: number): void {
  // Three low posts across the road.
  for (let i = -1; i <= 1; i++) {
    const px = ox + i * tw * 0.22;
    const py = oy + th * 0.5 + i * th * 0.0;
    ctx.fillStyle = '#5d4a2e';
    ctx.fillRect(px - 1.6 * sc, py - 8 * sc, 3.2 * sc, 9 * sc);
    ctx.fillStyle = '#8a6f45';
    ctx.fillRect(px - 1.6 * sc, py - 8 * sc, 3.2 * sc, 2.4 * sc);
  }
}

function drawFestivalSquare(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG): void {
  diamondPath(ctx, ox, oy, s, tw, th);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#e0d4ae';
  ctx.fillRect(ox - (s * tw) / 2, oy, s * tw, s * th);
  // Painted radial pattern.
  ctx.strokeStyle = '#c08a4e';
  ctx.lineWidth = 1.6 * sc;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(ox, oy + (s * th) / 2);
    ctx.lineTo(ox + Math.cos(a) * s * tw * 0.4, oy + (s * th) / 2 + Math.sin(a) * s * th * 0.4);
    ctx.stroke();
  }
  ctx.strokeStyle = '#8f7fc0';
  ctx.lineWidth = 2 * sc;
  ctx.beginPath();
  ctx.ellipse(ox, oy + (s * th) / 2, s * tw * 0.22, s * th * 0.22, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  // Banner poles at the corners.
  for (const [dx, dy] of [[-0.4, 0.5], [0.4, 0.5]] as [number, number][]) {
    const px = ox + dx * s * tw;
    const py = oy + dy * s * th;
    ctx.strokeStyle = '#7a5f38';
    ctx.lineWidth = 2 * sc;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py - 26 * sc);
    ctx.stroke();
    ctx.fillStyle = '#c9564a';
    ctx.fillRect(px, py - 26 * sc, 9 * sc, 7 * sc);
  }
}

function drawGarden(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG): void {
  diamondPath(ctx, ox, oy, s, tw, th);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#4e7c3a';
  ctx.fillRect(ox - (s * tw) / 2, oy, s * tw, s * th);
  speckle(ctx, rng, ox - (s * tw) / 2, oy, s * tw, s * th, 40, ['#5f8f45', '#3f6a30', '#6ba04a']);
  // Reflecting pool.
  ctx.fillStyle = '#4f8fa8';
  ctx.beginPath();
  ctx.ellipse(ox, oy + (s * th) / 2, tw * 0.2, th * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#d0c39c';
  ctx.lineWidth = 1.4 * sc;
  ctx.stroke();
  ctx.restore();
  // A palm at the back corner.
  ctx.save();
  ctx.translate(ox - tw * 0.28, oy - th * 0.1);
  drawPalm(ctx, sc * 0.8, 3);
  ctx.restore();
}

function drawFarm(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG, def: BuildingDef): void {
  // Ploughed field over the whole footprint.
  diamondPath(ctx, ox, oy, s, tw, th);
  ctx.save();
  ctx.clip();
  const soil = mix(def.art.base, '#3f3a20', 0.35);
  ctx.fillStyle = soil;
  ctx.fillRect(ox - (s * tw) / 2, oy, s * tw, s * th);

  // Crop rows following one iso axis.
  const rows = s * 5;
  for (let i = 0; i < rows; i++) {
    const t = i / rows;
    const sx = ox - (s * tw) / 2 + t * s * tw;
    ctx.strokeStyle = i % 2 ? def.art.roof : mix(def.art.roof, '#000000', 0.18);
    ctx.lineWidth = 2.2 * sc;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(sx, oy + t * 0);
    ctx.lineTo(sx + (s * tw) / 2, oy + (s * th) / 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Little crop tufts.
  for (let i = 0; i < s * s * 7; i++) {
    const px = ox + rng.float(-0.42, 0.42) * s * tw;
    const py = oy + rng.float(0.12, 0.88) * s * th;
    ctx.strokeStyle = def.art.roof;
    ctx.lineWidth = 1.1 * sc;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + rng.float(-1.5, 1.5) * sc, py - rng.float(2.5, 5) * sc);
    ctx.stroke();
  }
  ctx.restore();

  // Farmhouse in the north corner.
  const hx = ox;
  const hy = oy;
  isoBox(ctx, hx, hy + th * 0.1, 0.8, 12 * sc, mix('#b08a55', '#ffffff', 0.15), shade('#b08a55', 0.68), shade('#b08a55', 0.86), tw, th);
  // Thatch.
  ctx.fillStyle = '#a08a44';
  diamondPath(ctx, hx, hy + th * 0.1 - 12 * sc - 3 * sc, 0.9, tw, th);
  ctx.fill();
}

function drawMine(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG, def: BuildingDef): void {
  // Scraped ground.
  diamondPath(ctx, ox, oy, s, tw, th);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = mix(def.art.base, '#4a3a28', 0.45);
  ctx.fillRect(ox - (s * tw) / 2, oy, s * tw, s * th);
  speckle(ctx, rng, ox - (s * tw) / 2, oy, s * tw, s * th, 50 * s,
    [def.art.base, def.art.roof, mix(def.art.base, '#000', 0.3)]);
  ctx.restore();

  // Spoil heaps.
  for (let i = 0; i < s + 1; i++) {
    const px = ox + rng.float(-0.3, 0.3) * s * tw;
    const py = oy + rng.float(0.3, 0.8) * s * th;
    ctx.fillStyle = mix(def.art.base, '#000', 0.15);
    ctx.beginPath();
    ctx.ellipse(px, py, 8 * sc, 4 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = def.art.base;
    ctx.beginPath();
    ctx.ellipse(px, py - 2 * sc, 6 * sc, 3 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Timber head-frame over the shaft.
  const cx = ox;
  const cy = oy + (s * th) / 2;
  ctx.strokeStyle = '#6b5334';
  ctx.lineWidth = 2.2 * sc;
  ctx.beginPath();
  ctx.moveTo(cx - 8 * sc, cy + 4 * sc);
  ctx.lineTo(cx, cy - 14 * sc);
  ctx.lineTo(cx + 8 * sc, cy + 4 * sc);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 5 * sc, cy - 4 * sc);
  ctx.lineTo(cx + 5 * sc, cy - 4 * sc);
  ctx.stroke();
  // Dark shaft mouth.
  ctx.fillStyle = '#2b2018';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 5 * sc, 5 * sc, 2.6 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawWharf(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG, def: BuildingDef): void {
  // Plank deck.
  diamondPath(ctx, ox, oy, s, tw, th);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#8a6a45';
  ctx.fillRect(ox - (s * tw) / 2, oy, s * tw, s * th);
  ctx.strokeStyle = '#6f5334';
  ctx.lineWidth = 1.2 * sc;
  for (let i = 0; i < s * 6; i++) {
    const t = i / (s * 6);
    ctx.beginPath();
    ctx.moveTo(ox - (s * tw) / 2 + t * s * tw, oy + t * 0);
    ctx.lineTo(ox - (s * tw) / 2 + t * s * tw + (s * tw) / 2, oy + (s * th) / 2);
    ctx.stroke();
  }
  ctx.restore();

  // Mooring posts.
  for (let i = 0; i < 2; i++) {
    const px = ox + (i ? 1 : -1) * s * tw * 0.28;
    const py = oy + s * th * 0.55;
    ctx.fillStyle = '#5f4a2e';
    ctx.fillRect(px - 1.8 * sc, py - 11 * sc, 3.6 * sc, 12 * sc);
  }
  // A moored reed boat.
  const bx = ox + s * tw * 0.1;
  const by = oy + s * th * 0.8;
  ctx.fillStyle = '#c9ae63';
  ctx.beginPath();
  ctx.moveTo(bx - 14 * sc, by);
  ctx.quadraticCurveTo(bx, by + 5 * sc, bx + 14 * sc, by);
  ctx.quadraticCurveTo(bx + 10 * sc, by - 3.5 * sc, bx, by - 3 * sc);
  ctx.quadraticCurveTo(bx - 10 * sc, by - 3.5 * sc, bx - 14 * sc, by);
  ctx.fill();
  ctx.strokeStyle = '#8a7040';
  ctx.lineWidth = 1 * sc;
  ctx.stroke();

  // Small hut for the crew.
  isoBox(ctx, ox - tw * 0.2, oy + th * 0.1, 0.7, 11 * sc,
    mix(def.art.roof, '#ffffff', 0.2), shade(def.art.roof, 0.62), shade(def.art.roof, 0.82), tw, th);
}

function drawReedStructure(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, h: number, sc: number, rng: RNG, base: string, roof: string): void {
  // Low mud walls...
  isoBox(ctx, ox, oy, s * 0.86, h * 0.55, mix(base, '#ffffff', 0.14), shade(base, 0.66), shade(base, 0.88), tw, th);
  // ...under a pitched matting canopy on poles.
  const hw = (s * 0.86 * tw) / 2;
  const hh = (s * 0.86 * th) / 2;
  const topY = oy - h * 0.55;
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(ox, topY - h * 0.42);
  ctx.lineTo(ox + hw * 1.15, topY + hh);
  ctx.lineTo(ox, topY + hh * 2 + h * 0.05);
  ctx.lineTo(ox - hw * 1.15, topY + hh);
  ctx.closePath();
  ctx.fill();
  // Matting texture.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = shade(roof, 0.78, 0.5);
  ctx.lineWidth = 1 * sc;
  for (let i = -6; i < 10; i++) {
    ctx.beginPath();
    ctx.moveTo(ox - hw * 1.2 + i * 5 * sc, topY - h * 0.5);
    ctx.lineTo(ox - hw * 1.2 + i * 5 * sc + hw, topY + hh * 2);
    ctx.stroke();
  }
  ctx.restore();
  // Corner poles.
  ctx.strokeStyle = '#6b5334';
  ctx.lineWidth = 1.8 * sc;
  for (const [px, py] of [[ox - hw, topY + hh], [ox + hw, topY + hh]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py + h * 0.55);
    ctx.stroke();
  }
}

function drawMudBuilding(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, h: number, sc: number, rng: RNG, base: string, roof: string, accent: string): void {
  const bodyS = s * 0.88;
  isoBox(ctx, ox, oy, bodyS, h, mix(base, '#ffffff', 0.16), shade(base, 0.63), shade(base, 0.87), tw, th);

  const hw = (bodyS * tw) / 2;
  const hh = (bodyS * th) / 2;
  const topY = oy - h;

  // Flat roof with a low parapet.
  ctx.fillStyle = roof;
  diamondPath(ctx, ox, topY, bodyS, tw, th);
  ctx.fill();
  ctx.strokeStyle = shade(roof, 0.7);
  ctx.lineWidth = 1.6 * sc;
  ctx.stroke();

  // Roof clutter: drying pots and matting.
  for (let i = 0; i < Math.max(1, s); i++) {
    const px = ox + rng.float(-0.28, 0.28) * bodyS * tw;
    const py = topY + hh + rng.float(-0.3, 0.3) * bodyS * th;
    ctx.fillStyle = '#b3653f';
    ctx.beginPath();
    ctx.ellipse(px, py, 2.6 * sc, 1.8 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Doorway on the south-east face.
  const dx = ox + hw * 0.45;
  const dy = oy + hh * 1.45;
  ctx.fillStyle = '#38281a';
  ctx.beginPath();
  ctx.moveTo(dx - 3 * sc, dy);
  ctx.lineTo(dx + 3 * sc, dy - 3 * sc);
  ctx.lineTo(dx + 3 * sc, dy - 3 * sc - h * 0.5);
  ctx.lineTo(dx - 3 * sc, dy - h * 0.5);
  ctx.closePath();
  ctx.fill();

  // A painted band near the top — this is what makes mud brick read as Egyptian.
  ctx.save();
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(ox, oy + hh * 2 - h * 0.86);
  ctx.lineTo(ox + hw, oy + hh - h * 0.86);
  ctx.lineTo(ox + hw, oy + hh - h * 0.94);
  ctx.lineTo(ox, oy + hh * 2 - h * 0.94);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(ox - hw, oy + hh - h * 0.86);
  ctx.lineTo(ox, oy + hh * 2 - h * 0.86);
  ctx.lineTo(ox, oy + hh * 2 - h * 0.94);
  ctx.lineTo(ox - hw, oy + hh - h * 0.94);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Weathering streaks.
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 1 * sc;
  for (let i = 0; i < 6; i++) {
    const t = rng.next();
    const px = ox + hw * t;
    const py = oy + hh * 2 - hh * t;
    ctx.beginPath();
    ctx.moveTo(px, py - h);
    ctx.lineTo(px, py - h * rng.float(0.1, 0.5));
    ctx.stroke();
  }
  ctx.restore();
}

function drawStoneBuilding(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, h: number, sc: number, rng: RNG, base: string, roof: string, accent: string): void {
  const bodyS = s * 0.9;
  // A stepped plinth reads as dressed stone rather than mud.
  isoBox(ctx, ox, oy, bodyS, h * 0.12, mix(base, '#000', 0.1), shade(base, 0.6), shade(base, 0.8), tw, th);
  isoBox(ctx, ox, oy - h * 0.12, bodyS * 0.94, h * 0.88,
    mix(base, '#ffffff', 0.2), shade(base, 0.66), shade(base, 0.9), tw, th);

  const hw = (bodyS * 0.94 * tw) / 2;
  const hh = (bodyS * 0.94 * th) / 2;
  const topY = oy - h;

  ctx.fillStyle = roof;
  diamondPath(ctx, ox, topY, bodyS * 0.94, tw, th);
  ctx.fill();

  // Ashlar courses on the visible faces.
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = shade(base, 0.55);
  ctx.lineWidth = 1 * sc;
  const courses = Math.max(2, Math.round(h / (7 * sc)));
  for (let i = 1; i < courses; i++) {
    const yy = (h * 0.88 * i) / courses;
    ctx.beginPath();
    ctx.moveTo(ox - hw, oy + hh - h * 0.12 - yy);
    ctx.lineTo(ox, oy + hh * 2 - h * 0.12 - yy);
    ctx.lineTo(ox + hw, oy + hh - h * 0.12 - yy);
    ctx.stroke();
  }
  ctx.restore();

  // Doorway with a lintel.
  const dx = ox + hw * 0.4;
  const dy = oy + hh * 1.5;
  ctx.fillStyle = '#2e2418';
  ctx.beginPath();
  ctx.moveTo(dx - 3.4 * sc, dy);
  ctx.lineTo(dx + 3.4 * sc, dy - 3.4 * sc);
  ctx.lineTo(dx + 3.4 * sc, dy - 3.4 * sc - h * 0.45);
  ctx.lineTo(dx - 3.4 * sc, dy - h * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(dx - 4 * sc, dy - h * 0.5, 8 * sc, 2 * sc);
}

function drawTemple(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, h: number, sc: number, rng: RNG, def: BuildingDef): void {
  const base = def.art.base;
  const godColor = def.art.roof;

  // Raised platform.
  isoBox(ctx, ox, oy, s * 0.95, h * 0.14, mix(base, '#000', 0.08), shade(base, 0.6), shade(base, 0.8), tw, th);

  const bodyS = s * 0.72;
  const bodyY = oy - h * 0.14;

  // Battered (tapering) walls — the signature of Egyptian temple architecture.
  isoTaper(ctx, ox, bodyY, bodyS, h * 0.72, 0.86,
    mix(base, '#ffffff', 0.22), shade(base, 0.66), shade(base, 0.9), tw, th);

  const hw = (bodyS * tw) / 2;
  const hh = (bodyS * th) / 2;

  // Cavetto cornice: a flared lip at the top.
  const corniceY = bodyY - h * 0.72;
  ctx.fillStyle = mix(base, '#ffffff', 0.32);
  diamondPath(ctx, ox, corniceY - h * 0.06, bodyS * 1.06, tw, th);
  ctx.fill();
  ctx.fillStyle = godColor;
  ctx.globalAlpha = 0.85;
  diamondPath(ctx, ox, corniceY - h * 0.1, bodyS * 0.92, tw, th);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Twin flagstaffs with the god's pennants.
  for (const sx of [-1, 1]) {
    const px = ox + sx * hw * 0.72;
    const py = bodyY + hh + Math.abs(sx) * 0;
    ctx.strokeStyle = '#7a5f38';
    ctx.lineWidth = 2 * sc;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py - h * 1.05);
    ctx.stroke();
    ctx.fillStyle = godColor;
    ctx.beginPath();
    ctx.moveTo(px, py - h * 1.05);
    ctx.lineTo(px + 10 * sc, py - h * 0.98);
    ctx.lineTo(px, py - h * 0.88);
    ctx.closePath();
    ctx.fill();
  }

  // Entrance between two pylons on the south-east.
  const ex = ox + hw * 0.3;
  const ey = bodyY + hh * 1.55;
  ctx.fillStyle = '#2b2116';
  ctx.beginPath();
  ctx.moveTo(ex - 4 * sc, ey);
  ctx.lineTo(ex + 4 * sc, ey - 4 * sc);
  ctx.lineTo(ex + 4 * sc, ey - 4 * sc - h * 0.4);
  ctx.lineTo(ex - 4 * sc, ey - h * 0.4);
  ctx.closePath();
  ctx.fill();

  // Painted register of glyph-like marks.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = godColor;
  for (let i = 0; i < 6; i++) {
    const t = 0.15 + i * 0.12;
    const px = ox + hw * t;
    const py = bodyY + hh * 2 - hh * t - h * 0.4;
    ctx.fillRect(px - 1 * sc, py, 2 * sc, 4 * sc);
  }
  ctx.restore();
}

function drawMonument(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, h: number, sc: number, rng: RNG, def: BuildingDef): void {
  const base = def.art.base;
  switch (def.id) {
    case 'mon_pyramid': {
      // A true pyramid: one big taper to a point.
      isoTaper(ctx, ox, oy, s, h, 0.03,
        mix(base, '#ffffff', 0.3), shade(base, 0.62), shade(base, 0.95), tw, th);
      // Sun-catch highlight along the SE arris.
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = '#fff6d8';
      ctx.lineWidth = 2.4 * sc;
      ctx.beginPath();
      ctx.moveTo(ox, oy + (s * th));
      ctx.lineTo(ox, oy + (s * th) / 2 - h);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'mon_step_pyramid': {
      const tiers = 6;
      let cy = oy;
      let size = s;
      for (let i = 0; i < tiers; i++) {
        const th2 = h / tiers;
        isoBox(ctx, ox, cy, size, th2,
          mix(base, '#ffffff', 0.18 + i * 0.02), shade(base, 0.6), shade(base, 0.88), tw, th);
        cy -= th2;
        size *= 0.82;
      }
      break;
    }
    case 'mon_mastaba': {
      isoTaper(ctx, ox, oy, s * 0.9, h, 0.78,
        mix(base, '#ffffff', 0.16), shade(base, 0.62), shade(base, 0.86), tw, th);
      // Panelled "palace facade" niching.
      ctx.save();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = '#4a3520';
      ctx.lineWidth = 1.6 * sc;
      const hw = (s * 0.9 * tw) / 2;
      for (let i = 1; i < 7; i++) {
        const t = i / 7;
        ctx.beginPath();
        ctx.moveTo(ox + hw * t, oy + (s * 0.9 * th) - (s * 0.9 * th) / 2 * t);
        ctx.lineTo(ox + hw * t, oy + (s * 0.9 * th) - (s * 0.9 * th) / 2 * t - h);
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case 'mon_obelisk': {
      // Slender shaft on a plinth, tipped with gold.
      isoBox(ctx, ox, oy, s * 0.8, h * 0.08, mix(base, '#000', 0.1), shade(base, 0.6), shade(base, 0.8), tw, th);
      isoTaper(ctx, ox, oy - h * 0.08, s * 0.26, h * 0.8, 0.62,
        mix(base, '#ffffff', 0.28), shade(base, 0.6), shade(base, 0.92), tw, th);
      // Pyramidion.
      const capY = oy - h * 0.88;
      isoTaper(ctx, ox, capY, s * 0.16, h * 0.12, 0.02,
        '#f0d478', '#b08b22', '#e0b437', tw, th);
      // Incised column of glyphs.
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#5f4a2e';
      for (let i = 0; i < 9; i++) {
        ctx.fillRect(ox + 1 * sc, oy - h * 0.14 - i * h * 0.075, 2.6 * sc, 3.4 * sc);
      }
      ctx.restore();
      break;
    }
    case 'mon_sphinx': {
      // Body.
      const bodyH = h * 0.42;
      isoBox(ctx, ox, oy + th * s * 0.18, s * 0.78, bodyH,
        mix(base, '#ffffff', 0.2), shade(base, 0.66), shade(base, 0.9), tw, th);
      // Haunches.
      ctx.fillStyle = shade(base, 0.94);
      ctx.beginPath();
      ctx.ellipse(ox - tw * s * 0.16, oy + th * s * 0.5, tw * s * 0.16, bodyH * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      // Head with nemes headcloth.
      const hx = ox + tw * s * 0.22;
      const hy = oy + th * s * 0.2 - bodyH;
      isoBox(ctx, hx, hy, s * 0.26, h * 0.34,
        mix(base, '#ffffff', 0.3), shade(base, 0.7), shade(base, 0.95), tw, th);
      ctx.fillStyle = '#3f6f9a';
      ctx.beginPath();
      ctx.moveTo(hx - tw * s * 0.14, hy + th * s * 0.13 - h * 0.34);
      ctx.lineTo(hx + tw * s * 0.14, hy + th * s * 0.13 - h * 0.34);
      ctx.lineTo(hx + tw * s * 0.16, hy + th * s * 0.13 - h * 0.16);
      ctx.lineTo(hx - tw * s * 0.16, hy + th * s * 0.13 - h * 0.16);
      ctx.closePath();
      ctx.fill();
      // Face.
      ctx.fillStyle = mix(base, '#c98f5c', 0.5);
      ctx.beginPath();
      ctx.ellipse(hx + tw * s * 0.04, hy + th * s * 0.16 - h * 0.2, 5 * sc, 6 * sc, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'mon_sun_temple': {
      isoBox(ctx, ox, oy, s * 0.94, h * 0.3,
        mix(base, '#ffffff', 0.18), shade(base, 0.64), shade(base, 0.88), tw, th);
      // Open court.
      ctx.fillStyle = mix(base, '#ffffff', 0.34);
      diamondPath(ctx, ox, oy - h * 0.3, s * 0.94, tw, th);
      ctx.fill();
      // Squat benben at the centre.
      isoTaper(ctx, ox, oy - h * 0.3, s * 0.3, h * 0.62, 0.1,
        '#f0d478', shade('#e0a832', 0.65), '#e0a832', tw, th);
      // Colonnade around the edge.
      ctx.fillStyle = shade(base, 0.7);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const px = ox + Math.cos(a) * s * tw * 0.4;
        const py = oy - h * 0.3 + (s * th) / 2 + Math.sin(a) * s * th * 0.4;
        ctx.fillRect(px - 1.6 * sc, py - 12 * sc, 3.2 * sc, 12 * sc);
      }
      break;
    }
    default:
      isoTaper(ctx, ox, oy, s * 0.9, h, 0.4,
        mix(base, '#ffffff', 0.2), shade(base, 0.64), shade(base, 0.9), tw, th);
  }
}

function drawTower(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, h: number, sc: number, rng: RNG, def: BuildingDef): void {
  const base = def.art.base;
  const bodyS = def.id === 'wall' ? s * 0.7 : s * 0.86;
  isoBox(ctx, ox, oy, bodyS, h, mix(base, '#ffffff', 0.18), shade(base, 0.62), shade(base, 0.88), tw, th);

  const hw = (bodyS * tw) / 2;
  const hh = (bodyS * th) / 2;
  const topY = oy - h;

  ctx.fillStyle = def.art.roof;
  diamondPath(ctx, ox, topY, bodyS, tw, th);
  ctx.fill();

  // Crenellations along the two visible top edges.
  ctx.fillStyle = mix(base, '#ffffff', 0.28);
  const merlons = Math.max(3, Math.round(bodyS * 3));
  for (let i = 0; i < merlons; i++) {
    const t = (i + 0.5) / merlons;
    const rx = ox + hw * t;
    const ry = topY + hh * t;
    ctx.fillRect(rx - 1.6 * sc, ry - 5 * sc, 3.2 * sc, 5 * sc);
    const lx = ox - hw * t;
    const ly = topY + hh * t;
    ctx.fillRect(lx - 1.6 * sc, ly - 5 * sc, 3.2 * sc, 5 * sc);
  }

  if (def.id === 'gatehouse') {
    const dx = ox;
    const dy = oy + hh * 2;
    ctx.fillStyle = '#2b2116';
    ctx.beginPath();
    ctx.moveTo(dx - 6 * sc, dy - 2 * sc);
    ctx.lineTo(dx + 6 * sc, dy - 2 * sc);
    ctx.lineTo(dx + 6 * sc, dy - 2 * sc - h * 0.55);
    ctx.lineTo(dx - 6 * sc, dy - 2 * sc - h * 0.55);
    ctx.closePath();
    ctx.fill();
  }
  if (def.cat === 'military' && def.garrison) {
    // A standard planted on the roof.
    ctx.strokeStyle = '#6b5334';
    ctx.lineWidth = 2 * sc;
    ctx.beginPath();
    ctx.moveTo(ox, topY + hh);
    ctx.lineTo(ox, topY + hh - 18 * sc);
    ctx.stroke();
    ctx.fillStyle = '#c9564a';
    ctx.fillRect(ox, topY + hh - 18 * sc, 10 * sc, 7 * sc);
  }
}

/**
 * Housing art. Twenty ladder rungs would be twenty sprites of wasted atlas, so five
 * visual tiers cover the range and the tint shifts within each tier.
 */
function drawHouse(ctx: CanvasRenderingContext2D, ox: number, oy: number, tw: number, th: number, sc: number, rng: RNG, tier: number): void {
  const palettes = [
    { wall: '#a98a63', roof: '#8a6a3f', h: 10 },  // huts
    { wall: '#b89a70', roof: '#8f7146', h: 13 },  // shanties / cottages
    { wall: '#c6ab80', roof: '#96784c', h: 17 },  // homesteads
    { wall: '#d2bb96', roof: '#a08355', h: 21 },  // apartments / residences
    { wall: '#e0cfae', roof: '#b08f5c', h: 26 },  // manors / estates
  ];
  const t = clamp(tier, 0, palettes.length - 1);
  const p = palettes[t];
  const h = p.h * sc;

  if (t === 0) {
    // A crude hut: a lopsided mud box under a shaggy reed roof.
    isoBox(ctx, ox, oy + th * 0.1, 0.74, h, mix(p.wall, '#ffffff', 0.14), shade(p.wall, 0.56), shade(p.wall, 0.9), tw, th);
    ctx.fillStyle = '#6f5a2e';
    diamondPath(ctx, ox, oy + th * 0.1 - h - 1 * sc, 0.9, tw, th);
    ctx.fill();
    ctx.fillStyle = '#9c8248';
    diamondPath(ctx, ox, oy + th * 0.1 - h - 3.5 * sc, 0.86, tw, th);
    ctx.fill();
    // Thatch strands.
    ctx.strokeStyle = '#7f6a38';
    ctx.lineWidth = 1 * sc;
    for (let i = -3; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(ox + i * 3.4 * sc, oy + th * 0.1 - h - 3.5 * sc + Math.abs(i) * 1.4 * sc);
      ctx.lineTo(ox + i * 3.4 * sc, oy + th * 0.1 - h + 1 * sc + Math.abs(i) * 1.2 * sc);
      ctx.stroke();
    }
    ctx.fillStyle = '#2b1f14';
    ctx.fillRect(ox + tw * 0.09, oy + th * 0.52, 3.4 * sc, 5.5 * sc);
    return;
  }

  // Better housing gets a courtyard wall and more than one block.
  const bodyS = 0.8;
  isoBox(ctx, ox, oy, bodyS, h, mix(p.wall, '#ffffff', 0.22), shade(p.wall, 0.58), shade(p.wall, 0.92), tw, th);

  // The roof oversails the walls slightly and casts a line of shade under the eaves —
  // without it the whole thing reads as one flat block of colour.
  ctx.fillStyle = shade(p.roof, 0.55);
  diamondPath(ctx, ox, oy - h + 1.5 * sc, bodyS * 0.92, tw, th);
  ctx.fill();
  ctx.fillStyle = p.roof;
  diamondPath(ctx, ox, oy - h, bodyS * 0.92, tw, th);
  ctx.fill();
  ctx.strokeStyle = shade(p.roof, 1.25);
  ctx.lineWidth = 1.2 * sc;
  ctx.stroke();

  // A sunlit strip down the south-east wall.
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#fff2d0';
  const lhw = (bodyS * tw) / 2;
  const lhh = (bodyS * th) / 2;
  ctx.beginPath();
  ctx.moveTo(ox, oy + lhh * 2);
  ctx.lineTo(ox + lhw, oy + lhh);
  ctx.lineTo(ox + lhw, oy + lhh - h * 0.35);
  ctx.lineTo(ox, oy + lhh * 2 - h * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (t >= 2) {
    // A second storey, offset to the north.
    isoBox(ctx, ox, oy - h, bodyS * 0.62, h * 0.55,
      mix(p.wall, '#ffffff', 0.26), shade(p.wall, 0.68), shade(p.wall, 0.92), tw, th);
    ctx.fillStyle = shade(p.roof, 1.06);
    diamondPath(ctx, ox, oy - h - h * 0.55, bodyS * 0.62, tw, th);
    ctx.fill();
  }
  if (t >= 3) {
    // Roof terrace with an awning.
    ctx.fillStyle = '#c9564a';
    ctx.globalAlpha = 0.85;
    diamondPath(ctx, ox + tw * 0.14, oy - h - 3 * sc, 0.3, tw, th);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (t >= 4) {
    // Painted band and a garden pot: the mark of an estate.
    ctx.fillStyle = '#4f8ab5';
    ctx.globalAlpha = 0.7;
    const hw = (bodyS * tw) / 2;
    const hh = (bodyS * th) / 2;
    ctx.beginPath();
    ctx.moveTo(ox, oy + hh * 2 - h * 0.8);
    ctx.lineTo(ox + hw, oy + hh - h * 0.8);
    ctx.lineTo(ox + hw, oy + hh - h * 0.88);
    ctx.lineTo(ox, oy + hh * 2 - h * 0.88);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#4e7c3a';
    ctx.beginPath();
    ctx.arc(ox - tw * 0.26, oy + th * 0.62, 3.4 * sc, 0, Math.PI * 2);
    ctx.fill();
  }

  // Door.
  ctx.fillStyle = '#33251a';
  const dx = ox + tw * 0.16;
  const dy = oy + th * 0.62;
  ctx.beginPath();
  ctx.moveTo(dx - 2.4 * sc, dy);
  ctx.lineTo(dx + 2.4 * sc, dy - 2.4 * sc);
  ctx.lineTo(dx + 2.4 * sc, dy - 2.4 * sc - h * 0.42);
  ctx.lineTo(dx - 2.4 * sc, dy - h * 0.42);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

export const WALKER_LOOKS = [
  'civilian', 'priest', 'water', 'seller', 'cart', 'immigrant', 'soldier', 'enemy',
  'laborer', 'official', 'entertainer', 'physician',
] as const;
export type WalkerLook = typeof WALKER_LOOKS[number];

const LOOK_COLORS: Record<WalkerLook, { skin: string; cloth: string; accent: string }> = {
  civilian:    { skin: '#a9764c', cloth: '#e6ddc6', accent: '#8a6a3f' },
  priest:      { skin: '#a9764c', cloth: '#f2ecd8', accent: '#c9a24a' },
  water:       { skin: '#a9764c', cloth: '#cfe0e4', accent: '#4f8fa8' },
  seller:      { skin: '#a9764c', cloth: '#e2c98f', accent: '#b3653f' },
  cart:        { skin: '#96683f', cloth: '#d5c39a', accent: '#7a5433' },
  immigrant:   { skin: '#96683f', cloth: '#c9b48c', accent: '#6f5c3a' },
  soldier:     { skin: '#a9764c', cloth: '#c2a05a', accent: '#9aa2a8' },
  enemy:       { skin: '#7d5636', cloth: '#8f5a4a', accent: '#5f3a2a' },
  laborer:     { skin: '#8f6238', cloth: '#cbb68c', accent: '#7a6238' },
  official:    { skin: '#a9764c', cloth: '#efe6cc', accent: '#8f7fc0' },
  entertainer: { skin: '#a9764c', cloth: '#e8c0cb', accent: '#c9564a' },
  physician:   { skin: '#a9764c', cloth: '#e4ece6', accent: '#5f8f70' },
};

/**
 * A walker is a tiny figure — at normal zoom it is about ten pixels tall — so it is
 * drawn as readable blocks of colour rather than anatomy. Two frames give a walk bob.
 */
function drawWalker(ctx: CanvasRenderingContext2D, look: WalkerLook, dir: number, frame: number, sc: number): void {
  const c = LOOK_COLORS[look];
  const w = 24 * sc;
  const h = 30 * sc;
  const cx = w / 2;
  const feet = h - 3 * sc;
  const bob = frame === 1 ? -1 * sc : 0;
  const facingAway = dir === 0 || dir === 3;
  const facingLeft = dir === 2 || dir === 3;

  ctx.save();
  ctx.translate(0, bob);

  // Shadow.
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(cx, feet + 1.5 * sc, 4.6 * sc, 1.8 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Legs.
  ctx.strokeStyle = c.skin;
  ctx.lineWidth = 2 * sc;
  ctx.lineCap = 'round';
  const stride = frame === 1 ? 2.2 * sc : 0.8 * sc;
  ctx.beginPath();
  ctx.moveTo(cx - 1 * sc, feet - 7 * sc);
  ctx.lineTo(cx - 1 * sc - stride, feet);
  ctx.moveTo(cx + 1 * sc, feet - 7 * sc);
  ctx.lineTo(cx + 1 * sc + stride, feet);
  ctx.stroke();

  // Kilt / robe.
  ctx.fillStyle = c.cloth;
  ctx.beginPath();
  ctx.moveTo(cx - 3.6 * sc, feet - 15 * sc);
  ctx.lineTo(cx + 3.6 * sc, feet - 15 * sc);
  ctx.lineTo(cx + 4.2 * sc, feet - 6 * sc);
  ctx.lineTo(cx - 4.2 * sc, feet - 6 * sc);
  ctx.closePath();
  ctx.fill();

  // Torso.
  ctx.fillStyle = look === 'soldier' || look === 'enemy' ? c.accent : c.skin;
  ctx.beginPath();
  ctx.roundRect?.(cx - 3 * sc, feet - 20 * sc, 6 * sc, 7 * sc, 1.6 * sc);
  if (!ctx.roundRect) ctx.rect(cx - 3 * sc, feet - 20 * sc, 6 * sc, 7 * sc);
  ctx.fill();

  // Head.
  ctx.fillStyle = c.skin;
  ctx.beginPath();
  ctx.arc(cx, feet - 23 * sc, 3.2 * sc, 0, Math.PI * 2);
  ctx.fill();
  // Hair / headdress, omitted when walking away so the back of the head reads.
  ctx.fillStyle = look === 'priest' ? c.accent : '#2b2118';
  ctx.beginPath();
  ctx.arc(cx, feet - 24.4 * sc, 3.2 * sc, Math.PI, Math.PI * 2);
  ctx.fill();
  if (!facingAway) {
    ctx.fillStyle = '#2b2118';
    ctx.fillRect(cx - 1.8 * sc, feet - 23.4 * sc, 1 * sc, 1 * sc);
    ctx.fillRect(cx + 0.8 * sc, feet - 23.4 * sc, 1 * sc, 1 * sc);
  }

  // Per-role props.
  const side = facingLeft ? -1 : 1;
  switch (look) {
    case 'water': {
      ctx.fillStyle = '#8a5a3b';
      ctx.beginPath();
      ctx.ellipse(cx + side * 5 * sc, feet - 18 * sc, 2.6 * sc, 3.4 * sc, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'priest': {
      // A censer on a chain.
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1 * sc;
      ctx.beginPath();
      ctx.moveTo(cx + side * 4 * sc, feet - 18 * sc);
      ctx.lineTo(cx + side * 6 * sc, feet - 12 * sc);
      ctx.stroke();
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(cx + side * 6 * sc, feet - 11 * sc, 1.8 * sc, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'seller':
    case 'immigrant': {
      // A bundle carried on the head.
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.ellipse(cx, feet - 27.5 * sc, 5 * sc, 2.4 * sc, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'cart':
    case 'laborer': {
      // A sack over the shoulder.
      ctx.fillStyle = '#a89272';
      ctx.beginPath();
      ctx.ellipse(cx - side * 4.6 * sc, feet - 19 * sc, 4 * sc, 3.2 * sc, 0.3 * side, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'soldier': {
      ctx.strokeStyle = '#7a5f38';
      ctx.lineWidth = 1.4 * sc;
      ctx.beginPath();
      ctx.moveTo(cx + side * 4.4 * sc, feet - 26 * sc);
      ctx.lineTo(cx + side * 4.4 * sc, feet - 4 * sc);
      ctx.stroke();
      ctx.fillStyle = '#9aa2a8';
      ctx.beginPath();
      ctx.moveTo(cx + side * 4.4 * sc, feet - 27 * sc);
      ctx.lineTo(cx + side * 6.4 * sc, feet - 23 * sc);
      ctx.lineTo(cx + side * 2.4 * sc, feet - 23 * sc);
      ctx.closePath();
      ctx.fill();
      // Shield.
      ctx.fillStyle = c.cloth;
      ctx.beginPath();
      ctx.ellipse(cx - side * 4 * sc, feet - 16 * sc, 2.6 * sc, 4.4 * sc, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'enemy': {
      ctx.strokeStyle = '#5f3a2a';
      ctx.lineWidth = 1.4 * sc;
      ctx.beginPath();
      ctx.moveTo(cx + side * 4.4 * sc, feet - 24 * sc);
      ctx.lineTo(cx + side * 6 * sc, feet - 6 * sc);
      ctx.stroke();
      break;
    }
    case 'entertainer': {
      ctx.fillStyle = '#e0b437';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(cx + side * (3 + i * 1.6) * sc, feet - (26 + i * 2) * sc, 1.4 * sc, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'physician': {
      ctx.fillStyle = c.accent;
      ctx.fillRect(cx + side * 4 * sc, feet - 19 * sc, 3 * sc, 4 * sc);
      break;
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Effects and UI sprites
// ---------------------------------------------------------------------------

function drawFire(ctx: CanvasRenderingContext2D, frame: number, sc: number): void {
  const rng = new RNG(600 + frame * 71);
  const w = 32 * sc;
  const h = 40 * sc;
  const cx = w / 2;
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    const hh = h * (0.35 + rng.next() * 0.6) * (1 - t * 0.3);
    ctx.fillStyle = i < 2 ? 'rgba(255,214,110,0.95)' : i < 4 ? 'rgba(240,140,50,0.9)' : 'rgba(190,70,35,0.85)';
    ctx.beginPath();
    const px = cx + rng.float(-6, 6) * sc;
    ctx.moveTo(px, h);
    ctx.quadraticCurveTo(px - 5 * sc, h - hh * 0.5, px, h - hh);
    ctx.quadraticCurveTo(px + 5 * sc, h - hh * 0.5, px, h);
    ctx.fill();
  }
}

function drawSmoke(ctx: CanvasRenderingContext2D, frame: number, sc: number): void {
  const rng = new RNG(900 + frame * 37);
  const w = 32 * sc;
  const h = 40 * sc;
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? '#8f8a82' : '#a8a29a';
    ctx.beginPath();
    ctx.arc(w / 2 + rng.float(-6, 6) * sc, h - 8 * sc - i * 8 * sc, (4 + i * 1.8) * sc, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCursor(ctx: CanvasRenderingContext2D, ok: boolean, sc: number): void {
  const tw = TILE_W * sc;
  const thh = TILE_H * sc;
  diamondPath(ctx, tw / 2, 0, 1, tw, thh);
  ctx.fillStyle = ok ? 'rgba(120,220,140,0.32)' : 'rgba(230,90,80,0.34)';
  ctx.fill();
  ctx.strokeStyle = ok ? 'rgba(150,255,175,0.95)' : 'rgba(255,120,110,0.95)';
  ctx.lineWidth = 2 * sc;
  ctx.stroke();
}

function drawSelection(ctx: CanvasRenderingContext2D, sc: number): void {
  const tw = TILE_W * sc;
  const thh = TILE_H * sc;
  diamondPath(ctx, tw / 2, 0, 1, tw, thh);
  ctx.strokeStyle = 'rgba(255,236,170,0.95)';
  ctx.lineWidth = 2.4 * sc;
  ctx.setLineDash([6 * sc, 4 * sc]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A plain white diamond, tinted at draw time for the data overlays. */
function drawOverlayTile(ctx: CanvasRenderingContext2D, sc: number): void {
  const tw = TILE_W * sc;
  const thh = TILE_H * sc;
  diamondPath(ctx, tw / 2, 0, 1, tw, thh);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

/** A 1x1 white pixel, for solid-colour quads (bars, flashes, fog). */
function drawWhite(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 4, 4);
}

// ---------------------------------------------------------------------------
// Build the atlas
// ---------------------------------------------------------------------------

export function buildAtlas(onProgress?: (f: number) => void): Atlas {
  const jobs: PackJob[] = [];
  // Small art is supersampled; very large monuments are not, to keep the atlas sane.
  const SC = 2;
  const BIG_SC = 1;

  // Terrain and roads are painted by the ground pass (ground.ts), not as sprites.

  const featureDraws: [string, (ctx: CanvasRenderingContext2D, v: number) => void, number][] = [
    ['palm', (c, v) => drawPalm(c, SC, v), 56],
    ['acacia', (c, v) => drawAcacia(c, SC, v), 40],
    ['reeds', (c, v) => drawReeds(c, SC, v), 30],
    ['boulder', (c, v) => drawBoulder(c, SC, v), 20],
    ['bush', (c, v) => drawBush(c, SC, v), 16],
  ];
  for (const [name, fn, extra] of featureDraws) {
    for (let v = 0; v < 3; v++) {
      const h = (TILE_H + extra) * SC;
      jobs.push({
        name: `f_${name}_${v}`,
        w: TILE_W * SC, h, scale: SC, ax: (TILE_W * SC) / 2, ay: h - TILE_H * SC,
        draw: (ctx) => {
          ctx.save();
          ctx.translate(0, h - TILE_H * SC);
          fn(ctx, v);
          ctx.restore();
        },
      });
    }
  }

  for (const def of BUILDINGS) {
    if (def.cat === 'housing') continue; // housing is drawn per visual tier below
    const sc = def.size >= 4 ? BIG_SC : SC;
    const headroom = styleHeadroom(def.art.style, def.art.height * sc);
    const w = def.size * TILE_W * sc;
    const h = def.size * TILE_H * sc + headroom;
    jobs.push({
      name: `b_${def.id}`,
      w: Math.ceil(w), h: Math.ceil(h), scale: sc,
      ax: w / 2, ay: headroom,
      draw: (ctx) => drawBuilding(ctx, def, sc),
    });
  }

  // Housing tiers.
  const houseDef = BUILDINGS.find((b) => b.id === 'house')!;
  for (let tier = 0; tier < 5; tier++) {
    const sc = SC;
    const headroom = (30 + tier * 6) * sc;
    const w = TILE_W * sc;
    const h = TILE_H * sc + headroom;
    jobs.push({
      name: `house_${tier}`,
      w, h, scale: sc, ax: w / 2, ay: headroom,
      draw: (ctx) => {
        groundShadow(ctx, w / 2, headroom, 1, TILE_W * sc, TILE_H * sc);
        drawHouse(ctx, w / 2, headroom, TILE_W * sc, TILE_H * sc, sc, new RNG(tier * 31 + 7), tier);
      },
    });
  }
  // An empty, unclaimed housing lot: four corner pegs and a small placard on a stake,
  // the way a surveyor marks a plot. No fill — a district of lots waiting for settlers
  // should read as marked ground, not as a checkerboard.
  jobs.push({
    name: 'house_empty',
    w: TILE_W * SC, h: TILE_H * SC + 20 * SC, scale: SC, ax: (TILE_W * SC) / 2, ay: 20 * SC,
    draw: (ctx) => {
      const oy = 20 * SC;
      const cx = (TILE_W * SC) / 2;
      const hw = (TILE_W * SC) / 2 * 0.72;
      const hh = (TILE_H * SC) / 2 * 0.72;
      const my = oy + (TILE_H * SC) / 2;
      // Faint string between the pegs.
      ctx.strokeStyle = 'rgba(110,84,52,0.38)';
      ctx.lineWidth = 0.8 * SC;
      ctx.beginPath();
      ctx.moveTo(cx, my - hh);
      ctx.lineTo(cx + hw, my);
      ctx.lineTo(cx, my + hh);
      ctx.lineTo(cx - hw, my);
      ctx.closePath();
      ctx.stroke();
      // Pegs.
      ctx.fillStyle = '#6e5233';
      for (const [px, py] of [[cx, my - hh], [cx + hw, my], [cx, my + hh], [cx - hw, my]]) {
        ctx.fillRect(px - 0.9 * SC, py - 3.2 * SC, 1.8 * SC, 3.6 * SC);
      }
      // Placard on a stake.
      ctx.fillStyle = '#7a5a36';
      ctx.fillRect(cx - 0.8 * SC, my - 13 * SC, 1.6 * SC, 13 * SC);
      ctx.fillStyle = '#e9dcbf';
      ctx.fillRect(cx - 5 * SC, my - 17 * SC, 10 * SC, 6 * SC);
      ctx.strokeStyle = '#7a5a36';
      ctx.lineWidth = 0.9 * SC;
      ctx.strokeRect(cx - 5 * SC, my - 17 * SC, 10 * SC, 6 * SC);
      ctx.fillStyle = '#9c6b3c';
      ctx.fillRect(cx - 3 * SC, my - 15 * SC, 6 * SC, 0.9 * SC);
      ctx.fillRect(cx - 3 * SC, my - 13.3 * SC, 4 * SC, 0.9 * SC);
    },
  });

  // Construction scaffold, drawn over unfinished monuments.
  jobs.push({
    name: 'scaffold',
    w: TILE_W * SC, h: (TILE_H + 30) * SC, scale: SC, ax: (TILE_W * SC) / 2, ay: 30 * SC,
    draw: (ctx) => {
      const oy = 30 * SC;
      ctx.strokeStyle = '#8a6a44';
      ctx.lineWidth = 1.8 * SC;
      for (let i = -1; i <= 1; i += 2) {
        ctx.beginPath();
        ctx.moveTo(TILE_W * SC * 0.5 + i * 10 * SC, oy + TILE_H * SC * 0.5);
        ctx.lineTo(TILE_W * SC * 0.5 + i * 10 * SC, oy - 26 * SC);
        ctx.stroke();
      }
      for (let r = 0; r < 3; r++) {
        ctx.beginPath();
        ctx.moveTo(TILE_W * SC * 0.5 - 10 * SC, oy - r * 10 * SC);
        ctx.lineTo(TILE_W * SC * 0.5 + 10 * SC, oy - r * 10 * SC);
        ctx.stroke();
      }
    },
  });

  for (const look of WALKER_LOOKS) {
    for (let dir = 0; dir < 4; dir++) {
      for (let frame = 0; frame < 2; frame++) {
        jobs.push({
          name: `w_${look}_${dir}_${frame}`,
          w: 24 * SC, h: 30 * SC, scale: SC, ax: 12 * SC, ay: 30 * SC,
          draw: (ctx) => drawWalker(ctx, look, dir, frame, SC),
        });
      }
    }
  }

  for (let f = 0; f < 3; f++) {
    jobs.push({
      name: `fx_fire_${f}`, w: 32 * SC, h: 40 * SC, scale: SC, ax: 16 * SC, ay: 40 * SC,
      draw: (ctx) => drawFire(ctx, f, SC),
    });
    jobs.push({
      name: `fx_smoke_${f}`, w: 32 * SC, h: 40 * SC, scale: SC, ax: 16 * SC, ay: 40 * SC,
      draw: (ctx) => drawSmoke(ctx, f, SC),
    });
  }

  jobs.push({
    name: 'ui_cursor_ok', w: TILE_W * SC, h: TILE_H * SC, scale: SC, ax: (TILE_W * SC) / 2, ay: 0,
    draw: (ctx) => drawCursor(ctx, true, SC),
  });
  jobs.push({
    name: 'ui_cursor_bad', w: TILE_W * SC, h: TILE_H * SC, scale: SC, ax: (TILE_W * SC) / 2, ay: 0,
    draw: (ctx) => drawCursor(ctx, false, SC),
  });
  jobs.push({
    name: 'ui_select', w: TILE_W * SC, h: TILE_H * SC, scale: SC, ax: (TILE_W * SC) / 2, ay: 0,
    draw: (ctx) => drawSelection(ctx, SC),
  });
  jobs.push({
    name: 'ui_overlay', w: TILE_W * SC, h: TILE_H * SC, scale: SC, ax: (TILE_W * SC) / 2, ay: 0,
    draw: (ctx) => drawOverlayTile(ctx, SC),
  });
  jobs.push({
    name: 'white', w: 4, h: 4, scale: 1, ax: 0, ay: 0,
    draw: (ctx) => drawWhite(ctx),
  });

  return pack(jobs, onProgress);
}
