/**
 * Generates the PWA icons as real PNG files with no image dependencies.
 *
 * Node's zlib gives us the only hard part of a PNG; the rest is four chunks and a
 * CRC. The artwork is rasterised by hand into an RGBA buffer — a gilded pyramid under
 * a sun disc, which is about as on-the-nose as an icon for this game can be.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// --------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  // One filter byte (0 = None) in front of every scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- raster

class Raster {
  constructor(size) {
    this.size = size;
    this.buf = Buffer.alloc(size * size * 4);
  }
  /** Alpha-blend a colour into one pixel. */
  px(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return;
    const i = (y * this.size + x) * 4;
    const inv = 1 - a;
    this.buf[i] = Math.round(this.buf[i] * inv + r * a);
    this.buf[i + 1] = Math.round(this.buf[i + 1] * inv + g * a);
    this.buf[i + 2] = Math.round(this.buf[i + 2] * inv + b * a);
    this.buf[i + 3] = Math.round(this.buf[i + 3] * inv + 255 * a);
  }
  fill(r, g, b) {
    for (let i = 0; i < this.buf.length; i += 4) {
      this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = 255;
    }
  }
  /** Rounded-rectangle background, for the non-maskable icons. */
  roundedBg(radius, top, bottom) {
    const s = this.size;
    for (let y = 0; y < s; y++) {
      const t = y / (s - 1);
      const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
      const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
      const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
      for (let x = 0; x < s; x++) {
        const a = this.roundedCoverage(x, y, radius);
        if (a > 0) this.px(x, y, r, g, b, a);
      }
    }
  }
  roundedCoverage(x, y, radius) {
    const s = this.size;
    const cx = Math.min(x + 0.5, s - x - 0.5);
    const cy = Math.min(y + 0.5, s - y - 0.5);
    if (cx >= radius || cy >= radius) return 1;
    const dx = radius - cx;
    const dy = radius - cy;
    const d = Math.hypot(dx, dy);
    return Math.max(0, Math.min(1, radius - d + 0.5));
  }
  disc(cx, cy, radius, r, g, b, alpha = 1) {
    const s = this.size;
    for (let y = Math.max(0, Math.floor(cy - radius - 1)); y < Math.min(s, cy + radius + 2); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius - 1)); x < Math.min(s, cx + radius + 2); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const a = Math.max(0, Math.min(1, radius - d + 0.5)) * alpha;
        if (a > 0) this.px(x, y, r, g, b, a);
      }
    }
  }
  /** Filled triangle with a cheap analytic edge for antialiasing. */
  tri(p0, p1, p2, r, g, b, alpha = 1) {
    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(this.size - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(this.size - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
    const edge = (a, b2, px, py) => (b2[0] - a[0]) * (py - a[1]) - (b2[1] - a[1]) * (px - a[0]);
    const area = edge(p0, p1, p2[0], p2[1]);
    const sign = Math.sign(area) || 1;
    // Supersample 2x2 for smooth diagonals.
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let hits = 0;
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const px = x + ox;
          const py = y + oy;
          const w0 = edge(p0, p1, px, py) * sign;
          const w1 = edge(p1, p2, px, py) * sign;
          const w2 = edge(p2, p0, px, py) * sign;
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) hits++;
        }
        if (hits) this.px(x, y, r, g, b, (hits / 4) * alpha);
      }
    }
  }
}

/**
 * @param {number} size
 * @param {boolean} maskable  Maskable icons need the art inside the safe circle and a
 *                            background that bleeds to every edge.
 */
function drawIcon(size, maskable) {
  const img = new Raster(size);
  const s = size;

  if (maskable) {
    img.fill(0x12, 0x10, 0x0d);
    for (let y = 0; y < s; y++) {
      const t = y / s;
      for (let x = 0; x < s; x++) {
        img.px(x, y, 0x2a, 0x20, 0x16, (1 - t) * 0.55);
      }
    }
  } else {
    img.roundedBg(s * 0.22, [0x2b, 0x22, 0x17], [0x0e, 0x0c, 0x09]);
  }

  // Art is laid out inside a safe box so the maskable variant survives cropping.
  const inset = maskable ? s * 0.20 : s * 0.13;
  const box = s - inset * 2;
  const cx = s / 2;
  const groundY = inset + box * 0.80;

  // Sun disc behind the apex.
  img.disc(cx, inset + box * 0.30, box * 0.155, 0xe8, 0xb4, 0x3c, 0.95);
  img.disc(cx, inset + box * 0.30, box * 0.20, 0xe8, 0xb4, 0x3c, 0.16);

  // Pyramid: a lit right face and a shaded left face meeting at the apex.
  const apex = [cx, inset + box * 0.30];
  const left = [cx - box * 0.40, groundY];
  const right = [cx + box * 0.40, groundY];
  const base = [cx, groundY + box * 0.055];
  img.tri(apex, left, base, 0xa8, 0x8a, 0x54);
  img.tri(apex, base, right, 0xe4, 0xd0, 0x9e);

  // A band of river below it.
  for (let y = Math.round(groundY + box * 0.075); y < Math.round(groundY + box * 0.15); y++) {
    const t = (y - (groundY + box * 0.075)) / (box * 0.075);
    for (let x = Math.round(inset); x < Math.round(s - inset); x++) {
      img.px(x, y, 0x3f, 0x7d, 0x96, 0.85 - t * 0.35);
    }
  }

  return encodePNG(s, s, img.buf);
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
];

for (const [name, size, maskable] of targets) {
  const png = drawIcon(size, maskable);
  writeFileSync(join(outDir, name), png);
  console.log(`icons/${name}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
