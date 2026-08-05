/**
 * The map: terrain, the river, tile-level state and the road graph.
 *
 * All per-tile state lives in flat typed arrays indexed by `y * size + x`. This keeps
 * the whole map in a handful of contiguous buffers, which matters a great deal when the
 * renderer walks every visible tile at 120Hz on a phone.
 */

import { RNG, fbm, clamp, valueNoise2D } from './core';
import type { GoodId } from './data';

export const enum Terrain {
  Water = 0,
  Floodplain = 1, // the black land — floods annually, farms go here
  Desert = 2,     // the red land
  Dune = 3,
  Rock = 4,       // quarries and mines
  Marsh = 5,      // reeds, disease
  Grass = 6,      // scrub above the flood line
}

/** Natural features sitting on a tile, independent of terrain. */
export const enum Feature {
  None = 0,
  Palm = 1,
  Acacia = 2,
  Reeds = 3,
  Boulder = 4,
  Bush = 5,
}

/** What a tile can be mined or quarried for. */
export type Deposit = Extract<GoodId, 'limestone' | 'sandstone' | 'granite' | 'copper' | 'gold' | 'gems'>;
const DEPOSIT_CODES: (Deposit | null)[] = [null, 'limestone', 'sandstone', 'granite', 'copper', 'gold', 'gems'];

export interface TileInfo {
  x: number;
  y: number;
  terrain: Terrain;
  feature: Feature;
  deposit: Deposit | null;
  fertility: number;
  building: number;
  road: boolean;
  flooded: boolean;
  desirability: number;
}

export class World {
  readonly size: number;
  readonly area: number;

  readonly terrain: Uint8Array;
  readonly feature: Uint8Array;
  readonly deposit: Uint8Array;
  /** 0-100. Floodplain only; refreshed by the inundation, drained by farming. */
  readonly fertility: Uint8Array;
  /** Building instance id occupying this tile, or -1. */
  readonly building: Int32Array;
  /** 1 if a road (or plaza) is laid here. */
  readonly road: Uint8Array;
  /** 1 while the inundation covers this tile. */
  readonly flooded: Uint8Array;
  /** Signed desirability, recomputed incrementally. */
  readonly desirability: Int16Array;
  /** Cached "is this tile adjacent to open water" — used for docks, clay, fishing. */
  readonly nearWater: Uint8Array;
  /** Per-tile random byte, used by the renderer for art variation. */
  readonly variant: Uint8Array;
  /** Elevation in decimetres above the low-water line; drives flooding and shading. */
  readonly height: Uint8Array;

  /** Scratch buffers for pathfinding, allocated once. */
  private visitStamp: Int32Array;
  private visitEpoch = 0;
  private cameFrom: Int32Array;
  private queue: Int32Array;

  seed: number;

  constructor(size = 100, seed = 12345) {
    this.size = size;
    this.area = size * size;
    this.seed = seed;
    const a = this.area;
    this.terrain = new Uint8Array(a);
    this.feature = new Uint8Array(a);
    this.deposit = new Uint8Array(a);
    this.fertility = new Uint8Array(a);
    this.building = new Int32Array(a).fill(-1);
    this.road = new Uint8Array(a);
    this.flooded = new Uint8Array(a);
    this.desirability = new Int16Array(a);
    this.nearWater = new Uint8Array(a);
    this.variant = new Uint8Array(a);
    this.height = new Uint8Array(a);
    this.visitStamp = new Int32Array(a);
    this.cameFrom = new Int32Array(a);
    this.queue = new Int32Array(a);
  }

  idx(x: number, y: number): number {
    return y * this.size + x;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }
  xOf(i: number): number {
    return i % this.size;
  }
  yOf(i: number): number {
    return (i / this.size) | 0;
  }

  depositAt(i: number): Deposit | null {
    return DEPOSIT_CODES[this.deposit[i]] ?? null;
  }

  tileInfo(x: number, y: number): TileInfo | null {
    if (!this.inBounds(x, y)) return null;
    const i = this.idx(x, y);
    return {
      x, y,
      terrain: this.terrain[i] as Terrain,
      feature: this.feature[i] as Feature,
      deposit: this.depositAt(i),
      fertility: this.fertility[i],
      building: this.building[i],
      road: this.road[i] === 1,
      flooded: this.flooded[i] === 1,
      desirability: this.desirability[i],
    };
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /**
   * Carve a meandering Nile down the map, lay floodplain either side, then desert,
   * dunes and rock. The river's centreline is a sum of low-frequency sines so it reads
   * as a real waterway rather than a noise field.
   */
  generate(opts: { riverWidth?: number; floodplainWidth?: number; rockiness?: number; seed?: number } = {}): void {
    const seed = opts.seed ?? this.seed;
    this.seed = seed;
    const rng = new RNG(seed);
    const N = this.size;
    const riverW = opts.riverWidth ?? 7;
    const plainW = opts.floodplainWidth ?? 13;
    const rockiness = opts.rockiness ?? 1;

    // River centreline per row.
    const centre = new Float32Array(N);
    const baseX = N * 0.42 + rng.float(-N * 0.05, N * 0.05);
    const phase1 = rng.float(0, Math.PI * 2);
    const phase2 = rng.float(0, Math.PI * 2);
    for (let y = 0; y < N; y++) {
      const t = y / N;
      centre[y] =
        baseX +
        Math.sin(t * Math.PI * 2.1 + phase1) * N * 0.09 +
        Math.sin(t * Math.PI * 5.3 + phase2) * N * 0.035 +
        (fbm(seed + 77, 0, y * 0.06, 3) - 0.5) * N * 0.05;
    }

    for (let y = 0; y < N; y++) {
      const cx = centre[y];
      // River width wobbles a little so banks are not parallel lines.
      const w = riverW * (0.8 + fbm(seed + 5, 0, y * 0.09, 2) * 0.55);
      for (let x = 0; x < N; x++) {
        const i = this.idx(x, y);
        const d = Math.abs(x - cx);
        const n = fbm(seed + 11, x * 0.07, y * 0.07, 4);
        const edgeNoise = (n - 0.5) * 3.2;

        let t: Terrain;
        let h = 0;
        if (d < w * 0.5 + edgeNoise) {
          t = Terrain.Water;
          h = 0;
        } else if (d < w * 0.5 + 2 + edgeNoise && n > 0.52) {
          t = Terrain.Marsh;
          h = 2;
        } else if (d < w * 0.5 + plainW + edgeNoise * 2) {
          t = Terrain.Floodplain;
          // Gently rising away from the river — this is what the flood climbs.
          h = 3 + Math.floor(((d - w * 0.5) / plainW) * 9);
        } else {
          const far = d - (w * 0.5 + plainW);
          const dn = fbm(seed + 23, x * 0.045, y * 0.045, 4);
          const rockN = fbm(seed + 31, x * 0.05, y * 0.05, 5);
          if (rockN > 0.68 - rockiness * 0.06 && far > 4) {
            t = Terrain.Rock;
            h = 24 + Math.floor(rockN * 40);
          } else if (dn > 0.60) {
            t = Terrain.Dune;
            h = 14 + Math.floor(dn * 16);
          } else if (far < 3 && n > 0.55) {
            t = Terrain.Grass;
            h = 13;
          } else {
            t = Terrain.Desert;
            h = 13 + Math.floor(dn * 8);
          }
        }
        this.terrain[i] = t;
        this.height[i] = clamp(h, 0, 255);
        this.variant[i] = rng.int(256);
        this.fertility[i] = t === Terrain.Floodplain ? clamp(55 + Math.floor((n - 0.5) * 60), 20, 95) : 0;
      }
    }

    this.scatterFeatures(rng);
    this.scatterDeposits(rng);
    this.recomputeNearWater();
  }

  private scatterFeatures(rng: RNG): void {
    const N = this.size;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = this.idx(x, y);
        const t = this.terrain[i];
        const n = fbm(this.seed + 91, x * 0.18, y * 0.18, 3);
        let f = Feature.None;
        if (t === Terrain.Marsh) {
          if (n > 0.35) f = Feature.Reeds;
        } else if (t === Terrain.Floodplain) {
          if (n > 0.78 && rng.chance(0.35)) f = Feature.Palm;
          else if (n > 0.72 && rng.chance(0.18)) f = Feature.Bush;
        } else if (t === Terrain.Grass) {
          if (n > 0.6 && rng.chance(0.4)) f = Feature.Acacia;
          else if (rng.chance(0.25)) f = Feature.Bush;
        } else if (t === Terrain.Rock) {
          if (rng.chance(0.28)) f = Feature.Boulder;
        } else if (t === Terrain.Desert) {
          if (n > 0.82 && rng.chance(0.1)) f = Feature.Acacia;
        }
        this.feature[i] = f;
      }
    }
  }

  /**
   * Deposits cluster: a handful of seed points per resource, each grown into a blob.
   * Scattering per-tile at random produces unusable confetti instead of a quarry site.
   */
  private scatterDeposits(rng: RNG): void {
    const N = this.size;
    const rockTiles: number[] = [];
    for (let i = 0; i < this.area; i++) if (this.terrain[i] === Terrain.Rock) rockTiles.push(i);
    if (!rockTiles.length) return;

    const plan: { code: number; blobs: number; radius: number }[] = [
      { code: 1, blobs: 4, radius: 5 }, // limestone
      { code: 2, blobs: 3, radius: 5 }, // sandstone
      { code: 3, blobs: 2, radius: 4 }, // granite
      { code: 4, blobs: 3, radius: 4 }, // copper
      { code: 5, blobs: 2, radius: 3 }, // gold
      { code: 6, blobs: 2, radius: 3 }, // gems
    ];

    for (const p of plan) {
      for (let b = 0; b < p.blobs; b++) {
        const seedTile = rng.pick(rockTiles);
        const sx = this.xOf(seedTile);
        const sy = this.yOf(seedTile);
        const r = p.radius + rng.int(3);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = sx + dx;
            const y = sy + dy;
            if (!this.inBounds(x, y)) continue;
            const i = this.idx(x, y);
            if (this.terrain[i] !== Terrain.Rock) continue;
            const dist = Math.hypot(dx, dy);
            if (dist > r) continue;
            // Soft edge so blobs are not perfect circles.
            if (rng.next() > 1 - dist / (r + 1)) continue;
            if (this.deposit[i] === 0) this.deposit[i] = p.code;
          }
        }
      }
    }
  }

  recomputeNearWater(): void {
    const N = this.size;
    this.nearWater.fill(0);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = this.idx(x, y);
        if (this.terrain[i] !== Terrain.Water) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (this.inBounds(nx, ny)) this.nearWater[this.idx(nx, ny)] = 1;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Placement queries
  // -------------------------------------------------------------------------

  isBuildableTerrain(i: number): boolean {
    const t = this.terrain[i];
    return t !== Terrain.Water && t !== Terrain.Rock;
  }

  /** Can a `size`x`size` footprint be placed with its origin at (x,y)? */
  canPlace(x: number, y: number, size: number, req: string | undefined, allowRock = false): boolean {
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (!this.inBounds(px, py)) return false;
        const i = this.idx(px, py);
        if (this.building[i] !== -1) return false;
        if (this.road[i]) return false;
        const t = this.terrain[i];
        if (t === Terrain.Water) return false;
        if (t === Terrain.Rock && !allowRock) return false;
      }
    }
    return this.meetsTerrainRequirement(x, y, size, req);
  }

  meetsTerrainRequirement(x: number, y: number, size: number, req: string | undefined): boolean {
    if (!req || req === 'any') return true;
    let floodplain = 0;
    let dry = 0;
    let rock = 0;
    let marsh = 0;
    let adjacentWater = false;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const i = this.idx(x + dx, y + dy);
        const t = this.terrain[i];
        if (t === Terrain.Floodplain) floodplain++;
        if (t === Terrain.Desert || t === Terrain.Dune || t === Terrain.Grass) dry++;
        if (t === Terrain.Rock) rock++;
        if (t === Terrain.Marsh) marsh++;
        if (this.nearWater[i]) adjacentWater = true;
      }
    }
    const total = size * size;
    switch (req) {
      case 'floodplain': return floodplain >= total * 0.8;
      case 'dry': return dry >= total * 0.6;
      case 'rock': return rock >= 1;
      case 'marsh': return marsh >= 1;
      case 'water-adjacent': return adjacentWater;
      default: return true;
    }
  }

  /** Does any tile of this footprint touch a road? */
  touchesRoad(x: number, y: number, size: number): boolean {
    for (let dy = -1; dy <= size; dy++) {
      for (let dx = -1; dx <= size; dx++) {
        const edge = dx === -1 || dy === -1 || dx === size || dy === size;
        if (!edge) continue;
        // Only orthogonal edges count, not diagonal corners.
        if ((dx === -1 || dx === size) && (dy === -1 || dy === size)) continue;
        const px = x + dx;
        const py = y + dy;
        if (this.inBounds(px, py) && this.road[this.idx(px, py)]) return true;
      }
    }
    return false;
  }

  /** First road tile orthogonally adjacent to a footprint, or -1. */
  roadEntrance(x: number, y: number, size: number): number {
    for (let dy = -1; dy <= size; dy++) {
      for (let dx = -1; dx <= size; dx++) {
        const edge = dx === -1 || dy === -1 || dx === size || dy === size;
        if (!edge) continue;
        if ((dx === -1 || dx === size) && (dy === -1 || dy === size)) continue;
        const px = x + dx;
        const py = y + dy;
        if (this.inBounds(px, py) && this.road[this.idx(px, py)]) return this.idx(px, py);
      }
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Road graph
  // -------------------------------------------------------------------------

  /** Orthogonal road neighbours of a road tile, written into `out`. Returns count. */
  roadNeighbours(i: number, out: Int32Array): number {
    const N = this.size;
    const x = i % N;
    let n = 0;
    if (x > 0 && this.road[i - 1]) out[n++] = i - 1;
    if (x < N - 1 && this.road[i + 1]) out[n++] = i + 1;
    if (i >= N && this.road[i - N]) out[n++] = i - N;
    if (i < this.area - N && this.road[i + N]) out[n++] = i + N;
    return n;
  }

  /**
   * Breadth-first search across the road network from `start` to any tile for which
   * `isGoal` is true. Returns the path as an array of tile indices (start first), or
   * null if unreachable within `maxSteps`.
   *
   * Uses a stamped visited array so no allocation or clearing is needed per call —
   * this runs many times per simulated month.
   */
  findRoadPath(start: number, isGoal: (i: number) => boolean, maxSteps = 400): Int32Array | null {
    if (!this.road[start]) return null;
    const epoch = ++this.visitEpoch;
    const stamp = this.visitStamp;
    const from = this.cameFrom;
    const q = this.queue;
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    stamp[start] = epoch;
    from[start] = -1;
    const nb = new Int32Array(4);
    let steps = 0;

    while (head < tail) {
      const cur = q[head++];
      if (isGoal(cur)) return this.reconstruct(cur, from);
      if (++steps > maxSteps) break;
      const n = this.roadNeighbours(cur, nb);
      for (let k = 0; k < n; k++) {
        const nx = nb[k];
        if (stamp[nx] === epoch) continue;
        stamp[nx] = epoch;
        from[nx] = cur;
        q[tail++] = nx;
      }
    }
    return null;
  }

  private reconstruct(end: number, from: Int32Array): Int32Array {
    let len = 0;
    for (let c = end; c !== -1; c = from[c]) len++;
    const out = new Int32Array(len);
    let k = len - 1;
    for (let c = end; c !== -1; c = from[c]) out[k--] = c;
    return out;
  }

  /**
   * Visit every road tile in the same connected component as `start`.
   *
   * Used to answer "which part of my road network is this building actually on",
   * which matters because two road runs that look adjacent on screen may be entirely
   * separate as far as a walker is concerned.
   */
  forEachRoadInComponent(start: number, visit: (i: number) => void, maxTiles = 6000): void {
    if (!this.road[start]) return;
    const epoch = ++this.visitEpoch;
    const stamp = this.visitStamp;
    const q = this.queue;
    let head = 0;
    let tail = 0;
    q[tail++] = start;
    stamp[start] = epoch;
    const nb = new Int32Array(4);
    let n = 0;
    while (head < tail && n < maxTiles) {
      const cur = q[head++];
      n++;
      visit(cur);
      const c = this.roadNeighbours(cur, nb);
      for (let k = 0; k < c; k++) {
        const nx = nb[k];
        if (stamp[nx] === epoch) continue;
        stamp[nx] = epoch;
        q[tail++] = nx;
      }
    }
  }

  /** True if any road tile satisfying `isGoal` is reachable from `start`. */
  roadReachable(start: number, isGoal: (i: number) => boolean, maxSteps = 400): boolean {
    return this.findRoadPath(start, isGoal, maxSteps) !== null;
  }

  // -------------------------------------------------------------------------
  // Flood
  // -------------------------------------------------------------------------

  /**
   * Apply the inundation. `level` is 0..1, where 1 covers the whole floodplain.
   * Tiles below the resulting water height are flagged flooded; farms on them stop.
   */
  applyFlood(level: number): void {
    const maxH = 12;
    const waterH = level * maxH;
    for (let i = 0; i < this.area; i++) {
      const t = this.terrain[i];
      if (t === Terrain.Floodplain || t === Terrain.Marsh) {
        this.flooded[i] = this.height[i] <= waterH ? 1 : 0;
      } else {
        this.flooded[i] = 0;
      }
    }
  }

  /** Enrich the floodplain after the waters recede. `quality` 0..1. */
  depositSilt(quality: number): void {
    for (let i = 0; i < this.area; i++) {
      if (this.terrain[i] !== Terrain.Floodplain) continue;
      // Land the flood actually reached gains the most; the rest gains a little.
      const reached = this.flooded[i] === 1;
      const gain = (reached ? 34 : 8) * (0.45 + quality);
      const jitter = (valueNoise2D(this.seed + 401, this.xOf(i) * 0.3, this.yOf(i) * 0.3) - 0.5) * 8;
      this.fertility[i] = clamp(this.fertility[i] + gain + jitter, 0, 100);
    }
  }

  // -------------------------------------------------------------------------
  // Serialisation
  // -------------------------------------------------------------------------

  serialize(): any {
    const b64 = (a: Uint8Array | Int16Array | Int32Array) =>
      btoa(String.fromCharCode(...new Uint8Array(a.buffer, a.byteOffset, a.byteLength)));
    return {
      size: this.size,
      seed: this.seed,
      terrain: b64(this.terrain),
      feature: b64(this.feature),
      deposit: b64(this.deposit),
      fertility: b64(this.fertility),
      road: b64(this.road),
      variant: b64(this.variant),
      height: b64(this.height),
    };
  }

  static deserialize(data: any): World {
    const w = new World(data.size, data.seed);
    const put = (target: Uint8Array, s: string) => {
      const bin = atob(s);
      for (let i = 0; i < target.length; i++) target[i] = bin.charCodeAt(i);
    };
    put(w.terrain, data.terrain);
    put(w.feature, data.feature);
    put(w.deposit, data.deposit);
    put(w.fertility, data.fertility);
    put(w.road, data.road);
    put(w.variant, data.variant);
    put(w.height, data.height);
    w.recomputeNearWater();
    return w;
  }
}
