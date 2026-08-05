/**
 * Core primitives: deterministic RNG, math helpers, small event bus, fixed-point-ish
 * utilities shared by simulation and rendering.
 *
 * Everything the simulation touches must be deterministic so that a save file can be
 * replayed and so that the sim can be stepped independently of frame rate.
 */

/** Mulberry32 — small, fast, deterministic. Seedable and serialisable. */
export class RNG {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  get state() {
    return this.s;
  }
  set state(v: number) {
    this.s = v >>> 0 || 1;
  }
  /** [0,1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** integer in [0,n) */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** integer in [a,b] inclusive */
  range(a: number, b: number): number {
    return a + this.int(b - a + 1);
  }
  float(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const sign = Math.sign;

/** Move `a` toward `b` by at most `max`. */
export function approach(a: number, b: number, max: number): number {
  if (a < b) return Math.min(a + max, b);
  if (a > b) return Math.max(a - max, b);
  return b;
}

/** 2D value noise with smooth interpolation. Deterministic on (seed,x,y). */
export function valueNoise2D(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (a: number, b: number) => {
    let n = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
  const u = smoothstep(xf);
  const v = smoothstep(yf);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal Brownian motion over value noise. Returns roughly [0,1]. */
export function fbm(seed: number, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2D(seed + i * 1013, x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Tiny typed event bus. */
export class Emitter<E extends Record<string, any>> {
  private handlers = new Map<keyof E, Set<(p: any) => void>>();
  on<K extends keyof E>(k: K, fn: (p: E[K]) => void): () => void {
    let s = this.handlers.get(k);
    if (!s) this.handlers.set(k, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit<K extends keyof E>(k: K, p: E[K]): void {
    const s = this.handlers.get(k);
    if (!s) return;
    for (const fn of s) fn(p);
  }
}

/**
 * Fixed-capacity object pool backed by a free-list. Walkers churn heavily; allocating
 * thousands of objects per minute would make the GC visible at 120Hz.
 */
export class Pool<T> {
  private free: number[] = [];
  readonly items: (T | null)[] = [];
  constructor(private factory: () => T, private reset: (t: T) => void) {}
  alloc(): number {
    const id = this.free.pop();
    if (id !== undefined) {
      this.reset(this.items[id] as T);
      return id;
    }
    this.items.push(this.factory());
    return this.items.length - 1;
  }
  release(id: number): void {
    if (this.items[id] == null) return;
    this.free.push(id);
  }
  get(id: number): T {
    return this.items[id] as T;
  }
}

/** Format a number as Egyptian-flavoured currency (deben). */
export function money(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US');
}

export function plural(n: number, one: string, many?: string): string {
  return n === 1 ? one : many ?? one + 's';
}

/** Stable string hash, used for procedural art variation. */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
