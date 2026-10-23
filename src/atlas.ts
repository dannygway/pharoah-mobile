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

/**
 * Parse a colour. Accepts the hex this file writes by hand and the rgba() strings that
 * shade() and mix() return, so the helpers compose: mix(shade(c, 0.7), warm, 0.2).
 * Hex-only parsing turned any such nesting into NaN, which canvas renders as garbage.
 */
function hexToRgb(hex: string): [number, number, number] {
  if (hex.startsWith('rgb')) {
    const v = hex.slice(hex.indexOf('(') + 1, hex.indexOf(')')).split(',').map((n) => parseFloat(n));
    return [v[0] || 0, v[1] || 0, v[2] || 0];
  }
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

  switch (def.id) {
    case 'granary': drawGranary(ctx, ox, oy, s, tw, th, sc, rng); return;
    case 'bazaar': drawBazaar(ctx, ox, oy, s, tw, th, sc, rng); return;
    case 'storage_yard': drawStorageYard(ctx, ox, oy, s, tw, th, sc, rng); return;
    case 'water_supply': drawWaterSupply(ctx, ox, oy, s, tw, th, sc); return;
    case 'work_camp': drawWorkCamp(ctx, ox, oy, s, tw, th, sc, rng); return;
  }

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

// ---------------------------------------------------------------------------
// Signature buildings
//
// The handful of buildings a player looks at most — granary, bazaar, storage yard,
// water supply, work camp — each get their own drawing rather than a generic box, so
// a city reads at a glance the way Pharaoh's does: domed silos, striped awnings,
// stacked goods, a stone basin of water, a huddle of shelters.
// ---------------------------------------------------------------------------

/** Helpers shared by the signature drawings, in tile coordinates inside a footprint. */
function footprintKit(ctx: CanvasRenderingContext2D, ox: number, oy: number, tw: number, th: number, sc: number) {
  const at = (fx: number, fy: number): [number, number] => [ox + (fx - fy) * tw / 2, oy + (fx + fy) * th / 2];
  const poly = (pts: [number, number][], fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  };
  const floor = (fx: number, fy: number, w: number, d: number, fill: string) =>
    poly([at(fx, fy), at(fx + w, fy), at(fx + w, fy + d), at(fx, fy + d)], fill);
  const box = (fx: number, fy: number, size: number, h: number, top: string, left: string, right: string) => {
    const [x, y] = at(fx, fy);
    isoBox(ctx, x, y, size, h * sc, top, left, right, tw, th);
  };
  const wall = (a: [number, number], b: [number, number], h: number, face: string, cap: string) => {
    poly([a, b, [b[0], b[1] - h * sc], [a[0], a[1] - h * sc]], face);
    ctx.strokeStyle = cap;
    ctx.lineWidth = 1.2 * sc;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1] - h * sc);
    ctx.lineTo(b[0], b[1] - h * sc);
    ctx.stroke();
  };
  return { at, poly, floor, box, wall };
}

/** A mud-brick beehive silo: a short cylinder under a dome, with a hatch near the top. */
function drawSilo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, h: number, sc: number, body: string): void {
  const ry = r * 0.5;
  // Body.
  const g = ctx.createLinearGradient(x - r, 0, x + r, 0);
  g.addColorStop(0, mix(shade(body, 0.7), '#8a6438', 0.25));
  g.addColorStop(0.55, mix(body, '#fff4dc', 0.15));
  g.addColorStop(1, mix(shade(body, 0.88), '#b08050', 0.12));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x - r, y - h);
  ctx.lineTo(x - r, y);
  ctx.ellipse(x, y, r, ry, 0, Math.PI, 0, true);
  ctx.lineTo(x + r, y - h);
  ctx.closePath();
  ctx.fill();
  // Dome.
  ctx.beginPath();
  ctx.moveTo(x - r, y - h);
  ctx.bezierCurveTo(x - r, y - h - r * 1.5, x + r, y - h - r * 1.5, x + r, y - h);
  ctx.ellipse(x, y - h, r, ry, 0, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();
  // Hatch and a ladder.
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(x - 1.6 * sc, y - h - r * 0.55, 3.2 * sc, 3 * sc);
  ctx.strokeStyle = '#7a5a36';
  ctx.lineWidth = 0.9 * sc;
  ctx.beginPath();
  ctx.moveTo(x + r * 0.35, y + ry * 0.6);
  ctx.lineTo(x + r * 0.35, y - h - r * 0.3);
  ctx.moveTo(x + r * 0.62, y + ry * 0.4);
  ctx.lineTo(x + r * 0.62, y - h - r * 0.1);
  ctx.stroke();
}

function drawGranary(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG): void {
  const k = footprintKit(ctx, ox, oy, tw, th, sc);
  const mud = '#cdb184';
  k.floor(0.05, 0.05, s - 0.1, s - 0.1, '#bfa47a');
  // Back walls.
  k.wall(k.at(0.05, s - 0.05), k.at(0.05, 0.05), 7, shade(mud, 0.86), mix(mud, '#ffffff', 0.25));
  k.wall(k.at(0.05, 0.05), k.at(s - 0.05, 0.05), 7, shade(mud, 0.66), mix(mud, '#ffffff', 0.25));
  // Two rows of three silos, back to front.
  const spots: [number, number][] = [];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) spots.push([0.55 + i * 0.8, 0.5 + j * 0.85]);
  spots.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  for (const [fx, fy] of spots) {
    const [x, y] = k.at(fx, fy);
    drawSilo(ctx, x, y, tw * 0.17, th * 0.85, sc, mud);
  }
  // The scribe's office on the front corner, and sacks at the gate.
  k.box(s - 1.05, s - 1.05, 0.85, 12, mix(mud, '#ffffff', 0.18), shade(mud, 0.66), shade(mud, 0.88));
  for (let i = 0; i < 5; i++) {
    const [x, y] = k.at(0.4 + rng.float(0, 0.9), s - 0.45 + rng.float(-0.12, 0.12));
    ctx.fillStyle = i % 2 ? '#d9c08c' : '#c9ac74';
    ctx.beginPath();
    ctx.ellipse(x, y - 2.4 * sc, 3.6 * sc, 2.6 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Front walls, with a gap for the gate.
  k.wall(k.at(0.05, s - 0.05), k.at(s * 0.35, s - 0.05), 7, shade(mud, 0.66), mix(mud, '#ffffff', 0.25));
  k.wall(k.at(s - 0.05, 0.05), k.at(s - 0.05, s * 0.55), 7, shade(mud, 0.86), mix(mud, '#ffffff', 0.25));
}

function drawBazaar(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG): void {
  const k = footprintKit(ctx, ox, oy, tw, th, sc);
  // Beaten earth, a shade paler where the crowd stands.
  k.floor(0.04, 0.04, s - 0.08, s - 0.08, '#d6bf92');
  k.floor(0.6, 0.6, s - 1.2, s - 1.2, '#dcc89e');
  const awnings: [string, string][] = [['#c9564a', '#efe2c4'], ['#3f6f9a', '#efe2c4'], ['#b08a2e', '#f2e6c8'], ['#5f8a45', '#efe2c4']];
  // Four stalls around the square, back ones first.
  const stalls: [number, number][] = [[0.18, 0.18], [1.12, 0.18], [0.18, 1.12], [1.12, 1.12]];
  stalls.forEach(([fx, fy], i) => {
    const [x, y] = k.at(fx + 0.35, fy + 0.35);
    // Counter.
    k.box(fx + 0.12, fy + 0.12, 0.46, 5, '#a8865a', '#7a5a36', '#94744a');
    // Goods on the counter: little heaps in produce colours.
    const goods = ['#d8b24a', '#7fae4c', '#b0384b', '#c8a35a', '#e2ddcc'];
    for (let n = 0; n < 4; n++) {
      ctx.fillStyle = goods[(i + n) % goods.length];
      ctx.beginPath();
      ctx.arc(x + (n - 1.5) * 3.2 * sc, y - 5 * sc - (n % 2) * 1.2 * sc, 1.9 * sc, 0, Math.PI * 2);
      ctx.fill();
    }
    // Poles and a striped awning.
    const [a1, a2] = awnings[i];
    const top = 16 * sc;
    ctx.strokeStyle = '#6e5233';
    ctx.lineWidth = 1.3 * sc;
    for (const [px, py] of [k.at(fx + 0.08, fy + 0.62), k.at(fx + 0.62, fy + 0.08), k.at(fx + 0.62, fy + 0.62)]) {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - top);
      ctx.stroke();
    }
    const c0 = k.at(fx + 0.02, fy + 0.02), c1 = k.at(fx + 0.68, fy + 0.02);
    const c2 = k.at(fx + 0.68, fy + 0.68), c3 = k.at(fx + 0.02, fy + 0.68);
    const lift = (p: [number, number], d: number): [number, number] => [p[0], p[1] - top - d];
    k.poly([lift(c0, 3 * sc), lift(c1, 2 * sc), lift(c2, 0), lift(c3, 1 * sc)], a1);
    // Stripes.
    ctx.save();
    ctx.beginPath();
    const pts = [lift(c0, 3 * sc), lift(c1, 2 * sc), lift(c2, 0), lift(c3, 1 * sc)];
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = a2;
    ctx.lineWidth = 2.2 * sc;
    for (let t = -4; t <= 4; t++) {
      const [sx, sy] = k.at(fx + 0.35 + t * 0.12, fy - 0.2);
      ctx.beginPath();
      ctx.moveTo(sx, sy - top - 10 * sc);
      ctx.lineTo(sx + tw * 0.4, sy - top + th * 0.4);
      ctx.stroke();
    }
    ctx.restore();
  });
  // Jars and a basket in the middle of the square.
  for (let n = 0; n < 3; n++) {
    const [x, y] = k.at(0.85 + n * 0.12, 1.0 + rng.float(-0.1, 0.1));
    ctx.fillStyle = '#b3653f';
    ctx.beginPath();
    ctx.ellipse(x, y - 3 * sc, 2.4 * sc, 3.4 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStorageYard(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG): void {
  const k = footprintKit(ctx, ox, oy, tw, th, sc);
  const mud = '#b89a6c';
  k.floor(0.05, 0.05, s - 0.1, s - 0.1, '#c7ad82');
  k.wall(k.at(0.05, s - 0.05), k.at(0.05, 0.05), 8, shade(mud, 0.86), mix(mud, '#ffffff', 0.25));
  k.wall(k.at(0.05, 0.05), k.at(s - 0.05, 0.05), 8, shade(mud, 0.66), mix(mud, '#ffffff', 0.25));
  // An open-fronted shed along the back.
  k.box(0.12, 0.12, 0.9, 14, '#9a7f52', shade(mud, 0.62), shade(mud, 0.84));
  k.box(1.05, 0.12, 0.9, 14, '#9a7f52', shade(mud, 0.62), shade(mud, 0.84));
  // Piles of goods: crates, stacked brick, logs, jars.
  const piles: [number, number, string][] = [
    [0.5, 1.3, 'crates'], [1.4, 1.2, 'bricks'], [2.2, 1.0, 'logs'],
    [0.6, 2.2, 'jars'], [1.5, 2.1, 'crates'], [2.3, 2.0, 'stone'],
  ];
  piles.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  for (const [fx, fy, kind] of piles) {
    const [x, y] = k.at(fx, fy);
    if (kind === 'crates') {
      for (let j = 0; j < 3; j++) {
        const cx = x + (j - 1) * 5 * sc, cy = y - (j === 1 ? 6 : 0) * sc;
        isoBox(ctx, cx, cy - 4 * sc, 0.13, 5 * sc, '#c9a46a', '#8a6a40', '#a8844e', tw, th);
      }
    } else if (kind === 'bricks') {
      isoBox(ctx, x, y - 4 * sc, 0.3, 7 * sc, '#b0704a', '#7a4a30', '#94603e', tw, th);
    } else if (kind === 'logs') {
      ctx.fillStyle = '#7a5433';
      for (let j = 0; j < 4; j++) {
        ctx.beginPath();
        ctx.ellipse(x - 6 * sc + j * 4 * sc, y - 3 * sc - (j % 2) * 3 * sc, 2.6 * sc, 2.2 * sc, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#c49a62';
      ctx.beginPath();
      ctx.arc(x + 6 * sc, y - 3 * sc, 1.4 * sc, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'jars') {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = j % 2 ? '#b3653f' : '#c27a4a';
        ctx.beginPath();
        ctx.ellipse(x - 6 * sc + j * 4 * sc, y - 4 * sc, 2.2 * sc, 3.6 * sc, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      isoBox(ctx, x, y - 4 * sc, 0.26, 6 * sc, '#d8d0bc', '#9a9280', '#bab29c', tw, th);
    }
    void rng;
  }
  k.wall(k.at(0.05, s - 0.05), k.at(s * 0.4, s - 0.05), 8, shade(mud, 0.66), mix(mud, '#ffffff', 0.25));
  k.wall(k.at(s * 0.6, s - 0.05), k.at(s - 0.05, s - 0.05), 8, shade(mud, 0.66), mix(mud, '#ffffff', 0.25));
  k.wall(k.at(s - 0.05, 0.05), k.at(s - 0.05, s - 0.05), 8, shade(mud, 0.86), mix(mud, '#ffffff', 0.25));
}

function drawWaterSupply(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number): void {
  const k = footprintKit(ctx, ox, oy, tw, th, sc);
  const stone = '#cfc2a2';
  k.floor(0.05, 0.05, s - 0.1, s - 0.1, '#c8b892');
  // The cistern house at the back.
  k.box(0.12, 0.12, 0.95, 18, mix(stone, '#ffffff', 0.2), shade(stone, 0.64), shade(stone, 0.88));
  // A blue band and the doorway.
  const [dx, dy] = k.at(1.07, 0.6);
  ctx.fillStyle = '#2b2116';
  ctx.fillRect(dx - 2 * sc, dy - 9 * sc, 4 * sc, 9 * sc);
  // The open basin in front, stone-rimmed, full of water.
  const rim = (fx: number, fy: number, w: number) => k.floor(fx, fy, w, w, shade(stone, 0.8));
  rim(0.95, 0.95, 0.95);
  k.floor(1.03, 1.03, 0.79, 0.79, '#4f93a3');
  const [wx, wy] = k.at(1.3, 1.25);
  ctx.fillStyle = 'rgba(220,240,240,0.55)';
  ctx.beginPath();
  ctx.ellipse(wx, wy, 6 * sc, 1.6 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
  // Water jars waiting to be carried out.
  for (let j = 0; j < 4; j++) {
    const [x, y] = k.at(0.3 + j * 0.13, 1.55 + (j % 2) * 0.1);
    ctx.fillStyle = j % 2 ? '#b3653f' : '#c27a4a';
    ctx.beginPath();
    ctx.ellipse(x, y - 3.5 * sc, 2.3 * sc, 3.5 * sc, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWorkCamp(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, tw: number, th: number, sc: number, rng: RNG): void {
  const k = footprintKit(ctx, ox, oy, tw, th, sc);
  k.floor(0.05, 0.05, s - 0.1, s - 0.1, '#cbb084');
  // Reed shelters: a ridge roof over two poles, back ones first.
  const tents: [number, number][] = [[0.25, 0.2], [1.1, 0.25], [0.2, 1.05], [1.05, 1.1]];
  for (const [fx, fy] of tents) {
    const a = k.at(fx, fy + 0.25), b = k.at(fx + 0.6, fy + 0.25);
    const c = k.at(fx + 0.6, fy + 0.6), d = k.at(fx, fy + 0.6);
    const ridge = 11 * sc;
    const mid1: [number, number] = [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2 - ridge];
    const mid2: [number, number] = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2 - ridge];
    k.poly([a, b, mid2, mid1], '#a88a5a');
    k.poly([d, c, mid2, mid1], '#c9ac74');
    ctx.strokeStyle = '#8a6e44';
    ctx.lineWidth = 0.8 * sc;
    for (let t = 0.15; t < 1; t += 0.2) {
      ctx.beginPath();
      ctx.moveTo(d[0] + (c[0] - d[0]) * t, d[1] + (c[1] - d[1]) * t);
      ctx.lineTo(mid1[0] + (mid2[0] - mid1[0]) * t, mid1[1] + (mid2[1] - mid1[1]) * t);
      ctx.stroke();
    }
  }
  // A cooking fire and tools.
  const [fx, fy] = k.at(1.0, 0.95);
  ctx.fillStyle = '#5a4630';
  ctx.beginPath();
  ctx.ellipse(fx, fy, 4 * sc, 2 * sc, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e08a3a';
  ctx.beginPath();
  ctx.moveTo(fx - 2 * sc, fy);
  ctx.lineTo(fx, fy - 6 * sc);
  ctx.lineTo(fx + 2 * sc, fy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#7a5a36';
  ctx.lineWidth = 1.2 * sc;
  for (let i = 0; i < 3; i++) {
    const [x, y] = k.at(1.5 + rng.float(0, 0.3), 1.65 + i * 0.08);
    ctx.beginPath();
    ctx.moveTo(x - 5 * sc, y);
    ctx.lineTo(x + 5 * sc, y - 2 * sc);
    ctx.stroke();
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
  // Pharaoh's temple: a sanctuary hall behind a pylon gateway. The god's colour is on
  // the flags and in a painted band, not slapped across the roof.
  const stone = def.art.base;
  const god = def.art.roof;
  const k = footprintKit(ctx, ox, oy, tw, th, sc);
  const lit = mix(stone, '#fff4dc', 0.22);
  const dark = mix(shade(stone, 0.66), '#8a6438', 0.18);
  const mid = shade(stone, 0.9);

  // Paved forecourt.
  k.floor(0.04, 0.04, s - 0.08, s - 0.08, mix(stone, '#c8b48a', 0.5));
  // The hall: battered walls, stepped back from the gate.
  const hallS = s * 0.62;
  const [hx, hy] = k.at(0.12, 0.12);
  isoTaper(ctx, hx, hy, hallS, h * 0.62, 0.9, lit, dark, mid, tw, th);
  // Cornice band in the god's colour.
  ctx.save();
  ctx.globalAlpha = 0.85;
  const top = hy - h * 0.62;
  const cw = (hallS * 0.9 * tw) / 2, ch = (hallS * 0.9 * th) / 2;
  ctx.strokeStyle = god;
  ctx.lineWidth = 2 * sc;
  ctx.beginPath();
  ctx.moveTo(hx - cw, top + hallS * th * 0.5 + 1 * sc);
  ctx.lineTo(hx, top + hallS * th * 0.5 + ch + 1 * sc);
  ctx.lineTo(hx + cw, top + hallS * th * 0.5 + 1 * sc);
  ctx.stroke();
  ctx.restore();
  // Columns along the hall's sunlit face.
  {
    const n = Math.max(3, Math.round(s * 2));
    for (let i = 0; i <= n; i++) {
      const [x, y] = k.at(0.12 + hallS + 0.06, 0.12 + (i / n) * hallS);
      ctx.fillStyle = mix(stone, '#ffffff', 0.3);
      ctx.fillRect(x - 1.5 * sc, y - h * 0.5, 3 * sc, h * 0.5);
      ctx.fillStyle = god;
      ctx.fillRect(x - 2.2 * sc, y - h * 0.5, 4.4 * sc, 2 * sc);
    }
  }

  // The pylon gateway along the front edge: two tapering towers and a lintel.
  const pS = Math.max(0.42, s * 0.24);
  const gx = s - pS - 0.08;
  const towers: [number, number][] = [[gx, s * 0.1], [gx, s * 0.9 - pS]];
  // Flagstaffs stand before the towers; draw the far one first.
  for (const [fx, fy] of towers) {
    const [x, y] = k.at(fx, fy);
    isoTaper(ctx, x, y, pS, h * 0.95, 0.72, lit, dark, mid, tw, th);
    // Relief panel in the god's colour on the sunlit face.
    const [px, py] = k.at(fx + pS, fy + pS * 0.5);
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = god;
    ctx.fillRect(px - 2.5 * sc, py - h * 0.62, 5 * sc, h * 0.3);
    ctx.restore();
  }
  // Lintel between the towers, over the doorway.
  {
    const a = k.at(gx + pS * 0.6, s * 0.1 + pS), b2 = k.at(gx + pS * 0.6, s * 0.9 - pS);
    k.poly([a, b2, [b2[0], b2[1] - h * 0.62], [a[0], a[1] - h * 0.62]], '#2b2116');
    k.poly([[a[0], a[1] - h * 0.62], [b2[0], b2[1] - h * 0.62], [b2[0], b2[1] - h * 0.74], [a[0], a[1] - h * 0.74]], mid);
  }
  // Flagstaffs with pennants in the god's colour.
  for (const [fx, fy] of towers) {
    const [x, y] = k.at(fx + pS + 0.06, fy + pS * 0.5);
    ctx.strokeStyle = '#7a5f38';
    ctx.lineWidth = 1.8 * sc;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - h * 1.35);
    ctx.stroke();
    ctx.fillStyle = god;
    ctx.beginPath();
    ctx.moveTo(x, y - h * 1.35);
    ctx.lineTo(x + 9 * sc, y - h * 1.28);
    ctx.lineTo(x, y - h * 1.19);
    ctx.closePath();
    ctx.fill();
  }
  void rng;
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

/**
 * A house that has grown past one tile.
 *
 * Pharaoh's better housing is a walled compound, not a bigger hut: a perimeter wall,
 * a main block that rises a storey or two, and an open courtyard with a pool and
 * palms. 'kind' picks the scale of it. Everything is drawn back to front inside the
 * sprite so the front wall correctly hides the courtyard floor behind it.
 */
function drawCompound(
  ctx: CanvasRenderingContext2D, ox: number, oy: number, S: number,
  tw: number, th: number, sc: number, rng: RNG,
  kind: 'cluster' | 'cluster2' | 'residence' | 'residence2' | 'manor' | 'manor2' | 'estate' | 'estate2',
): void {
  // Ground point for fractional tile coordinates inside this footprint.
  const at = (fx: number, fy: number): [number, number] => [ox + (fx - fy) * tw / 2, oy + (fx + fy) * th / 2];

  if (kind === 'cluster' || kind === 'cluster2') {
    // Four small homes sharing one plot: drawn back to front.
    const tier = kind === 'cluster' ? 1 : 2;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const [x, y] = at(dx, dy);
      drawHouse(ctx, x, y, tw, th, sc, new RNG(rng.int(1e6)), tier);
    }
    return;
  }

  const palette = {
    residence:  { wall: '#e6d8b8', roof: '#c9b080', yard: '#d8c49a', band: '#b5543f', h: 20, wallH: 5 },
    residence2: { wall: '#ece0c4', roof: '#cdb486', yard: '#dccaa2', band: '#3f6f9a', h: 23, wallH: 5 },
    manor:      { wall: '#efe4ca', roof: '#d0b98c', yard: '#d9c79f', band: '#b5543f', h: 26, wallH: 6 },
    manor2:     { wall: '#f2e8d0', roof: '#d4bd90', yard: '#dccaa4', band: '#3f6f9a', h: 28, wallH: 6 },
    estate:     { wall: '#f4ebd6', roof: '#d8c296', yard: '#dccba6', band: '#3f6f9a', h: 30, wallH: 7 },
    estate2:    { wall: '#f7efdc', roof: '#dcc59a', yard: '#e0cfa9', band: '#b08a2e', h: 32, wallH: 7 },
  }[kind];
  const lit = mix(palette.wall, '#ffffff', 0.2);
  // Shadows on whitewash in strong sun go warm, not grey: bounce light off the sand.
  const shadeL = mix(shade(palette.wall, 0.66), '#9a7448', 0.22);
  const shadeR = mix(shade(palette.wall, 0.9), '#c49a62', 0.10);

  // Courtyard floor across the whole plot.
  const inset = 0.06;
  const quad = (pts: [number, number][], fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  };
  quad([at(inset, inset), at(S - inset, inset), at(S - inset, S - inset), at(inset, S - inset)], palette.yard);
  ctx.save();
  ctx.globalAlpha = 0.18;
  speckle(ctx, rng, ox - S * tw / 2, oy, S * tw, S * th, Math.round(30 * S * sc), ['#c2ab7e', '#efe2c4']);
  ctx.restore();

  // A wall run from a to b, wallH tall, with a lighter coping on top.
  const wallH = palette.wallH * sc;
  const wall = (a: [number, number], b: [number, number], face: string) => {
    quad([a, b, [b[0], b[1] - wallH], [a[0], a[1] - wallH]], face);
    ctx.strokeStyle = lit;
    ctx.lineWidth = 1.2 * sc;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1] - wallH);
    ctx.lineTo(b[0], b[1] - wallH);
    ctx.stroke();
  };
  // Back walls first.
  wall(at(inset, S - inset), at(inset, inset), shadeR);
  wall(at(inset, inset), at(S - inset, inset), shadeL);

  // Main house: a block across the back of the plot, a second storey on the larger.
  const box = (fx: number, fy: number, size: number, h: number, top = palette.roof) => {
    const [x, y] = at(fx, fy);
    isoBox(ctx, x, y, size, h * sc, top, shadeL, shadeR, tw, th);
    // Painted frieze just under the roof line on both faces.
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = palette.band;
    const hw = size * tw / 2, hh = size * th / 2, H = h * sc, bandY = H * 0.86, bandT = 1.6 * sc;
    quad([[x - hw, y + hh - bandY], [x, y + 2 * hh - bandY], [x, y + 2 * hh - bandY - bandT], [x - hw, y + hh - bandY - bandT]], palette.band);
    quad([[x, y + 2 * hh - bandY], [x + hw, y + hh - bandY], [x + hw, y + hh - bandY - bandT], [x, y + 2 * hh - bandY - bandT]], palette.band);
    ctx.restore();
    // Dark window slits on the sunlit face.
    ctx.fillStyle = 'rgba(45,32,20,0.85)';
    for (let k = 1; k <= Math.max(1, Math.round(size * 2)); k++) {
      const t = k / (Math.round(size * 2) + 1);
      const wx = x + hw * t, wy = y + 2 * hh - hh * t - H * 0.55;
      ctx.fillRect(wx - 1 * sc, wy - 3 * sc, 2 * sc, 3.5 * sc);
    }
  };

  const palm = (fx: number, fy: number, scale = 1) => {
    const [x, y] = at(fx, fy);
    const hgt = 22 * sc * scale;
    ctx.strokeStyle = '#7a5a36';
    ctx.lineWidth = 2 * sc * scale;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 2 * sc, y - hgt * 0.5, x + 1 * sc, y - hgt);
    ctx.stroke();
    ctx.fillStyle = '#4e7a35';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(x + 1 * sc + Math.cos(a) * 5 * sc * scale, y - hgt + Math.sin(a) * 2.2 * sc * scale,
        6 * sc * scale, 2 * sc * scale, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#6a9a48';
    ctx.beginPath();
    ctx.arc(x + 1 * sc, y - hgt - 1 * sc, 2.2 * sc * scale, 0, Math.PI * 2);
    ctx.fill();
  };
  const pool = (fx: number, fy: number, size: number) => {
    const [x, y] = at(fx, fy);
    ctx.fillStyle = shade(palette.yard, 0.8);
    diamondPath(ctx, x, y, size, tw, th);
    ctx.fill();
    ctx.fillStyle = '#4f93a3';
    diamondPath(ctx, x, y + size * th * 0.08, size * 0.84, tw, th);
    ctx.fill();
    ctx.fillStyle = 'rgba(220,240,240,0.5)';
    diamondPath(ctx, x - size * tw * 0.08, y + size * th * 0.18, size * 0.3, tw, th);
    ctx.fill();
  };
  const bed = (fx: number, fy: number, size: number) => {
    const [x, y] = at(fx, fy);
    ctx.fillStyle = '#6f8f45';
    diamondPath(ctx, x, y, size, tw, th);
    ctx.fill();
    ctx.fillStyle = '#c9564a';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(x + rng.float(-size, size) * tw * 0.2, y + size * th * 0.5 + rng.float(-0.3, 0.3) * size * th, 1.2 * sc, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  if (kind === 'residence' || kind === 'residence2') {
    box(0.12, 0.12, 1.15, palette.h);
    box(0.3, 0.25, 0.7, palette.h + 10);
    if (kind === 'residence2') {
      // A roof terrace with a striped awning.
      const [x, y] = at(0.45, 0.4);
      ctx.fillStyle = '#c9564a';
      diamondPath(ctx, x, y - (palette.h + 10) * sc - 4 * sc, 0.35, tw, th);
      ctx.fill();
    }
    palm(1.55, 1.25, 0.8);
    bed(1.2, 1.35, 0.35);
  } else if (kind === 'manor' || kind === 'manor2') {
    box(0.12, 0.12, 1.55, palette.h);
    box(1.72, 0.12, 1.0, palette.h - 8);
    box(0.35, 0.3, 0.9, palette.h + 12);
    pool(1.55, 1.55, 0.85);
    palm(2.5, 1.55);
    palm(1.5, 2.55, 0.9);
    if (kind === 'manor2') bed(2.2, 2.2, 0.45);
  } else {
    box(0.12, 0.12, 2.0, palette.h);
    box(2.2, 0.12, 1.4, palette.h - 8);
    box(0.4, 0.35, 1.3, palette.h + 14);
    // A colonnade along the front of the main house.
    {
      const H = palette.h * sc;
      for (let k = 0; k <= 5; k++) {
        const [x, y] = at(0.12 + 2.0 + 0.12, 0.12 + (k / 5) * 2.0);
        ctx.fillStyle = shade(palette.wall, 1.05);
        ctx.fillRect(x - 1.4 * sc, y - H, 2.8 * sc, H);
        ctx.fillStyle = '#4e8a5a';
        ctx.fillRect(x - 2 * sc, y - H, 4 * sc, 2 * sc);
      }
    }
    pool(2.3, 2.3, 1.2);
    palm(3.4, 2.1);
    palm(2.1, 3.4);
    palm(3.5, 3.3, 0.85);
    bed(1.2, 2.8, 0.6);
    bed(2.8, 1.2, 0.5);
    if (kind === 'estate2') {
      // A gilded obelisk in the garden: the estate's own small monument.
      const [x, y] = at(1.25, 2.3);
      isoTaper(ctx, x, y, 0.22, 30 * sc, 0.4, '#e0c060', '#a8862e', '#c9a24a', tw, th);
    }
  }

  // Front walls last, with a gateway in the south-west wall.
  const g0 = S * 0.42, g1 = S * 0.58;
  wall(at(inset, S - inset), at(g0, S - inset), shadeL);
  wall(at(g1, S - inset), at(S - inset, S - inset), shadeL);
  wall(at(S - inset, inset), at(S - inset, S - inset), shadeR);
  // Gate posts.
  for (const f of [g0, g1]) {
    const [x, y] = at(f, S - inset);
    ctx.fillStyle = lit;
    ctx.fillRect(x - 1.5 * sc, y - wallH - 4 * sc, 3 * sc, wallH + 4 * sc);
  }
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
  // Grown houses: residences, manors and estates, plus four-home clusters for
  // smaller houses that have ended up on a larger plot.
  const compounds: [number, string][] = [
    [2, 'cluster'], [2, 'cluster2'], [2, 'residence'], [2, 'residence2'],
    [3, 'manor'], [3, 'manor2'], [4, 'estate'], [4, 'estate2'],
  ];
  for (const [S, kind] of compounds) {
    const sc = SC;
    const headroom = (36 + S * 10) * sc;
    const w = S * TILE_W * sc;
    const h = S * TILE_H * sc + headroom;
    jobs.push({
      name: `house_${kind}`,
      w, h, scale: sc, ax: w / 2, ay: headroom,
      draw: (ctx) => {
        groundShadow(ctx, w / 2, headroom, S, TILE_W * sc, TILE_H * sc);
        drawCompound(ctx, w / 2, headroom, S, TILE_W * sc, TILE_H * sc, sc, new RNG(S * 101 + kind.length), kind as any);
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
      // A small placard on a stake — small enough that a district of fresh lots reads
      // as surveyed ground rather than as a field of signs.
      ctx.fillStyle = '#7a5a36';
      ctx.fillRect(cx - 0.6 * SC, my - 8 * SC, 1.2 * SC, 8 * SC);
      ctx.fillStyle = '#e4d6b4';
      ctx.fillRect(cx - 3.2 * SC, my - 11 * SC, 6.4 * SC, 3.8 * SC);
      ctx.fillStyle = '#9c6b3c';
      ctx.fillRect(cx - 2 * SC, my - 9.6 * SC, 4 * SC, 0.7 * SC);
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
