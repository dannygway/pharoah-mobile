/**
 * Scene rendering: the isometric camera, tile drawing, painter's-order object pass and
 * the data overlays.
 *
 * Objects are bucketed by isometric diagonal (x + y) rather than sorted, which keeps
 * the per-frame cost linear and allocation-free.
 */

import { clamp } from './core';
import { Atlas, Sprite, TILE_W, TILE_H } from './atlas';
import { Renderer } from './gl';
import { Terrain, Feature, World } from './world';
import { City, Building } from './sim';
import { Systems } from './systems';
import { HOUSING, BUILDING_BY_ID, GOD_IDS, RELIGION_SERVICE } from './data';

export type OverlayId =
  | 'none' | 'water' | 'desirability' | 'fire' | 'damage' | 'religion' | 'education'
  | 'entertainment' | 'health' | 'food' | 'tax' | 'crime' | 'workers' | 'fertility' | 'roads';

export const OVERLAYS: { id: OverlayId; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'water', name: 'Water' },
  { id: 'desirability', name: 'Desirability' },
  { id: 'fertility', name: 'Fertility' },
  { id: 'religion', name: 'Religion' },
  { id: 'education', name: 'Education' },
  { id: 'entertainment', name: 'Entertainment' },
  { id: 'health', name: 'Health' },
  { id: 'food', name: 'Food' },
  { id: 'tax', name: 'Tax' },
  { id: 'fire', name: 'Fire risk' },
  { id: 'damage', name: 'Damage' },
  { id: 'crime', name: 'Crime' },
  { id: 'workers', name: 'Employment' },
  { id: 'roads', name: 'Roads' },
];

export class Camera {
  /** Centre of the view in world pixels. */
  x = 0;
  y = 0;
  zoom = 1;
  minZoom = 0.34;
  maxZoom = 2.6;

  /** Smoothed target, so pinch and fling feel like iOS rather than like a spreadsheet. */
  tx = 0;
  ty = 0;
  tzoom = 1;
  vx = 0;
  vy = 0;

  worldSize = 100;

  centreOnTile(tx: number, ty: number): void {
    this.x = this.tx = (tx - ty) * (TILE_W / 2);
    this.y = this.ty = (tx + ty) * (TILE_H / 2);
    this.vx = this.vy = 0;
  }

  /** Integrate momentum and ease toward the target. */
  update(dt: number): void {
    // Fling decay, framerate independent.
    const decay = Math.pow(0.0016, dt);
    this.tx += this.vx * dt;
    this.ty += this.vy * dt;
    this.vx *= decay;
    this.vy *= decay;
    if (Math.abs(this.vx) < 2) this.vx = 0;
    if (Math.abs(this.vy) < 2) this.vy = 0;

    this.clampTarget();

    const k = 1 - Math.pow(0.0000015, dt);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.zoom += (this.tzoom - this.zoom) * k;
  }

  private clampTarget(): void {
    // Keep the camera roughly over the map: the diamond spans ±size*TILE_W/2 in x.
    const halfW = (this.worldSize * TILE_W) / 2;
    const maxY = this.worldSize * TILE_H;
    const pad = 260;
    this.tx = clamp(this.tx, -halfW - pad, halfW + pad);
    this.ty = clamp(this.ty, -pad, maxY + pad);
    this.tzoom = clamp(this.tzoom, this.minZoom, this.maxZoom);
  }

  /** Convert a CSS-pixel screen point to world pixels. */
  screenToWorld(sx: number, sy: number, viewW: number, viewH: number): [number, number] {
    return [
      (sx - viewW / 2) / this.zoom + this.x,
      (sy - viewH / 2) / this.zoom + this.y,
    ];
  }

  worldToScreen(wx: number, wy: number, viewW: number, viewH: number): [number, number] {
    return [
      (wx - this.x) * this.zoom + viewW / 2,
      (wy - this.y) * this.zoom + viewH / 2,
    ];
  }
}

/** World pixels for the top corner of a tile. */
export function tileToWorld(tx: number, ty: number): [number, number] {
  return [(tx - ty) * (TILE_W / 2), (tx + ty) * (TILE_H / 2)];
}

/** Fractional tile coordinates under a world-pixel point. */
export function worldToTile(wx: number, wy: number): [number, number] {
  const a = wx / (TILE_W / 2);
  const b = wy / (TILE_H / 2);
  return [(b + a) / 2, (b - a) / 2];
}

const SEASON_LIGHT: Record<string, [number, number, number]> = {
  akhet: [0.94, 0.97, 1.03],
  peret: [1.0, 1.0, 0.99],
  shemu: [1.06, 1.01, 0.92],
};

export class Scene {
  atlas: Atlas;
  renderer: Renderer;
  camera = new Camera();
  overlay: OverlayId = 'none';

  /** Tile the player is hovering / about to build on. */
  cursorTile = -1;
  /** Footprint preview: size and validity. */
  cursorSize = 1;
  cursorValid = true;
  /** Extra tiles to highlight (road drag preview). */
  previewTiles: number[] = [];
  /** Currently inspected building id. */
  selected = -1;

  private buckets: number[][] = [];
  private walkerBuckets: number[][] = [];
  private white: Sprite;

  /** Rolling frame time for the perf readout. */
  fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(atlas: Atlas, renderer: Renderer) {
    this.atlas = atlas;
    this.renderer = renderer;
    this.white = atlas.get('white');
  }

  // -------------------------------------------------------------------------

  render(city: City, systems: Systems, time: number, dt: number): void {
    const r = this.renderer;
    const w = city.world;
    const cam = this.camera;
    cam.worldSize = w.size;

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    // Sky/backdrop colour shifts with the season.
    const light = SEASON_LIGHT[city.season] ?? [1, 1, 1];
    r.begin([0.09 * light[0], 0.10 * light[1], 0.13 * light[2]]);

    // Visible tile bounds, from the four screen corners.
    const corners: [number, number][] = [
      cam.screenToWorld(0, 0, r.viewW, r.viewH),
      cam.screenToWorld(r.viewW, 0, r.viewW, r.viewH),
      cam.screenToWorld(0, r.viewH, r.viewW, r.viewH),
      cam.screenToWorld(r.viewW, r.viewH, r.viewW, r.viewH),
    ];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [wx, wy] of corners) {
      const [tx, ty] = worldToTile(wx, wy);
      minX = Math.min(minX, tx);
      maxX = Math.max(maxX, tx);
      minY = Math.min(minY, ty);
      maxY = Math.max(maxY, ty);
    }
    // Pad generously: tall buildings poke into the view from below and to the sides.
    const x0 = clamp(Math.floor(minX) - 3, 0, w.size - 1);
    const x1 = clamp(Math.ceil(maxX) + 3, 0, w.size - 1);
    const y0 = clamp(Math.floor(minY) - 3, 0, w.size - 1);
    const y1 = clamp(Math.ceil(maxY) + 10, 0, w.size - 1);

    this.drawTerrain(city, x0, y0, x1, y1, time, light);
    this.drawRoads(city, x0, y0, x1, y1, light);
    if (this.overlay !== 'none') this.drawOverlay(city, x0, y0, x1, y1);
    this.drawObjects(city, systems, x0, y0, x1, y1, time, light);
    this.drawCursor(city);

    r.flush(cam.x, cam.y, cam.zoom);
  }

  // -------------------------------------------------------------------------

  private drawTerrain(city: City, x0: number, y0: number, x1: number, y1: number, time: number, light: number[]): void {
    const r = this.renderer;
    const w = city.world;
    const a = this.atlas;
    const waterFrame = Math.floor(time * 3.2) % 4;
    const waterSp = a.get(`t_water_${waterFrame}`);
    const floodSp = [a.get('t_flooded_0'), a.get('t_flooded_1'), a.get('t_flooded_2')];

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const i = w.idx(tx, ty);
        const [wx, wy] = tileToWorld(tx, ty);
        const v = w.variant[i] % 3;
        const terr = w.terrain[i];

        let sp: Sprite;
        let tintR = light[0];
        let tintG = light[1];
        let tintB = light[2];

        switch (terr) {
          case Terrain.Water:
            sp = waterSp;
            break;
          case Terrain.Floodplain: {
            const fert = w.fertility[i];
            sp = a.get(fert > 58 ? `t_fertile_${v}` : `t_floodplain_${v}`);
            // Darker, richer soil where fertility is highest.
            const f = clamp(fert / 100, 0, 1);
            tintR *= 1.06 - f * 0.16;
            tintG *= 1.04 - f * 0.10;
            tintB *= 0.98 - f * 0.06;
            break;
          }
          case Terrain.Marsh:
            sp = a.get(`t_marsh_${v}`);
            break;
          case Terrain.Rock:
            sp = a.get(`t_rock_${v}`);
            break;
          case Terrain.Dune:
            sp = a.get(`t_dune_${v}`);
            break;
          case Terrain.Grass:
            sp = a.get(`t_grass_${v}`);
            break;
          default:
            sp = a.get(`t_desert_${v}`);
        }

        r.draw(sp, wx, wy, 1, tintR, tintG, tintB, 1);

        // The inundation lies over the floodplain as translucent water.
        if (w.flooded[i]) {
          r.draw(floodSp[v], wx, wy, 1, 0.86, 0.96, 1.0, 0.78);
          if ((tx + ty + waterFrame) % 7 === 0) {
            r.draw(waterSp, wx, wy, 1, 1, 1, 1, 0.20);
          }
        }
      }
    }
  }

  private drawRoads(city: City, x0: number, y0: number, x1: number, y1: number, light: number[]): void {
    const r = this.renderer;
    const w = city.world;
    const a = this.atlas;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const i = w.idx(tx, ty);
        if (!w.road[i]) continue;
        let mask = 0;
        if (ty > 0 && w.road[i - w.size]) mask |= 1;
        if (tx < w.size - 1 && w.road[i + 1]) mask |= 2;
        if (ty < w.size - 1 && w.road[i + w.size]) mask |= 4;
        if (tx > 0 && w.road[i - 1]) mask |= 8;
        const bId = w.building[i];
        const paved = bId >= 0 && city.buildings[bId]?.defId === 'plaza';
        const [wx, wy] = tileToWorld(tx, ty);
        r.draw(a.get(`road_${paved ? 'p' : 'd'}_${mask}`), wx, wy, 1, light[0], light[1], light[2], 1);
      }
    }
  }

  // -------------------------------------------------------------------------

  private drawObjects(city: City, systems: Systems, x0: number, y0: number, x1: number, y1: number, time: number, light: number[]): void {
    const r = this.renderer;
    const w = city.world;
    const a = this.atlas;

    const dMin = x0 + y0;
    const dMax = x1 + y1;
    const span = dMax - dMin + 1;

    // Reset buckets.
    while (this.buckets.length < span) this.buckets.push([]);
    while (this.walkerBuckets.length < span) this.walkerBuckets.push([]);
    for (let i = 0; i < span; i++) {
      this.buckets[i].length = 0;
      this.walkerBuckets[i].length = 0;
    }

    // Bucket buildings by the diagonal of their front-most tile.
    const seen = new Set<number>();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = w.building[w.idx(tx, ty)];
        if (id < 0 || seen.has(id)) continue;
        seen.add(id);
        const b = city.buildings[id];
        if (!b) continue;
        const d = b.x + b.y + (b.size - 1) * 2 - dMin;
        if (d >= 0 && d < span) this.buckets[d].push(id);
      }
    }

    // Bucket walkers.
    const ws = city.walkers;
    for (const id of ws.live) {
      const wk = ws.get(id);
      if (!wk) continue;
      if (wk.px < x0 - 2 || wk.px > x1 + 2 || wk.py < y0 - 2 || wk.py > y1 + 2) continue;
      const d = Math.floor(wk.px + wk.py) - dMin;
      if (d >= 0 && d < span) this.walkerBuckets[d].push(id);
    }

    // Features are drawn from the tile grid inline, in the same diagonal order.
    for (let d = 0; d < span; d++) {
      const diag = d + dMin;
      // Tiles on this diagonal, for natural features.
      const loX = Math.max(x0, diag - y1);
      const hiX = Math.min(x1, diag - y0);
      for (let tx = loX; tx <= hiX; tx++) {
        const ty = diag - tx;
        const i = w.idx(tx, ty);
        const f = w.feature[i];
        if (!f) continue;
        // A building or road covers whatever grew there.
        if (w.building[i] >= 0 || w.road[i]) continue;
        const [wx, wy] = tileToWorld(tx, ty);
        const v = w.variant[i] % 3;
        const name =
          f === Feature.Palm ? 'palm' :
          f === Feature.Acacia ? 'acacia' :
          f === Feature.Reeds ? 'reeds' :
          f === Feature.Boulder ? 'boulder' : 'bush';
        // Reeds sway; everything else is still.
        const sway = f === Feature.Reeds ? Math.sin(time * 1.6 + tx * 0.7 + ty * 0.4) * 0.6 : 0;
        r.draw(a.get(`f_${name}_${v}`), wx + sway, wy, 1, light[0], light[1], light[2], 1);
      }

      for (const id of this.buckets[d]) this.drawBuilding(city, systems, id, time, light);
      for (const id of this.walkerBuckets[d]) this.drawWalker(city, id, time, light);
    }
  }

  private drawBuilding(city: City, systems: Systems, id: number, time: number, light: number[]): void {
    const b = city.buildings[id];
    if (!b) return;
    const r = this.renderer;
    const a = this.atlas;
    const def = BUILDING_BY_ID[b.defId];
    if (def.id === 'road') return;
    const [wx, wy] = tileToWorld(b.x, b.y);

    let tR = light[0];
    let tG = light[1];
    let tB = light[2];
    let alpha = 1;

    // Mothballed or unstaffed buildings are visibly drained of colour.
    if (!b.enabled) {
      tR *= 0.6;
      tG *= 0.6;
      tB *= 0.62;
    } else if (def.workers > 0 && b.staffing < 0.34) {
      tR *= 0.82;
      tG *= 0.82;
      tB *= 0.86;
    }
    if (!b.hasRoad && def.needsRoad) {
      // Flag it clearly enough to notice, gently enough that a half-built district
      // does not look like it is on fire.
      tR *= 1.04;
      tG *= 0.84;
      tB *= 0.80;
    }

    if (b.house) {
      const lvl = b.house.level;
      if (lvl === 0 || b.house.people === 0) {
        r.draw(a.get('house_empty'), wx, wy, 1, tR, tG, tB, 1);
      } else {
        const tier = lvl <= 2 ? 0 : lvl <= 6 ? 1 : lvl <= 10 ? 2 : lvl <= 15 ? 3 : 4;
        r.draw(a.get(`house_${tier}`), wx, wy, 1, tR, tG, tB, 1);
      }
    } else if (b.monument && !b.monument.complete) {
      // Unfinished monuments rise out of the ground as the stages complete.
      const prog = systems.monumentProgress(b);
      const frac = clamp((b.monument.stage + prog.frac) / prog.total, 0.04, 1);
      const sp = a.get(`b_${def.id}`);
      // Draw the monument clipped by scaling its height contribution.
      r.draw(sp, wx, wy, 1, tR * 0.92, tG * 0.9, tB * 0.86, clamp(0.25 + frac * 0.75, 0, 1));
      // Scaffolding around the base while work is under way.
      for (let k = 0; k < def.size; k++) {
        const [sx, sy] = tileToWorld(b.x + k, b.y + def.size - 1);
        r.draw(a.get('scaffold'), sx, sy, 1, 1, 1, 1, 0.85);
      }
    } else {
      r.draw(a.get(`b_${def.id}`), wx, wy, 1, tR, tG, tB, alpha);
    }

    // Fire and smoke.
    if (b.fire > 82) {
      const f = Math.floor(time * 9 + b.variant) % 3;
      const [cx, cy] = tileToWorld(b.x + b.size / 2, b.y + b.size / 2);
      r.draw(a.get(`fx_fire_${f}`), cx, cy - def.art.height * 0.5, 1, 1, 1, 1, clamp((b.fire - 82) / 25, 0, 1));
    } else if (def.cat === 'industry' && b.staffing > 0.3 && b.enabled) {
      const f = Math.floor(time * 2 + b.variant) % 3;
      const [cx, cy] = tileToWorld(b.x + b.size / 2, b.y + b.size / 2);
      r.draw(a.get(`fx_smoke_${f}`), cx, cy - def.art.height, 1, 1, 1, 1, 0.35);
    }

    if (this.selected === id) {
      for (let dy = 0; dy < b.size; dy++) {
        for (let dx = 0; dx < b.size; dx++) {
          const [sx, sy] = tileToWorld(b.x + dx, b.y + dy);
          r.draw(a.get('ui_select'), sx, sy, 1, 1, 1, 1, 0.9);
        }
      }
    }
  }

  private drawWalker(city: City, id: number, time: number, light: number[]): void {
    const wk = city.walkers.get(id);
    if (!wk) return;
    const r = this.renderer;
    const a = this.atlas;
    const [wx, wy] = tileToWorld(wk.px, wk.py);
    const frame = Math.floor(time * 6 + wk.variant) % 2;

    let look = 'civilian';
    switch (wk.kind) {
      case 'service':
        look =
          wk.service === 'water' ? 'water' :
          wk.service && wk.service.startsWith('religion') ? 'priest' :
          wk.service === 'booth' || wk.service === 'bandstand' || wk.service === 'pavilion' ? 'entertainer' :
          wk.service === 'physician' || wk.service === 'apothecary' || wk.service === 'dentist' ? 'physician' :
          wk.service === 'tax' || wk.service === 'magistrate' ? 'official' :
          wk.service === 'school' || wk.service === 'library' ? 'official' : 'civilian';
        break;
      case 'seller': look = 'seller'; break;
      case 'buyer': look = 'seller'; break;
      case 'cart':
      case 'supply': look = 'cart'; break;
      case 'immigrant':
      case 'emigrant': look = 'immigrant'; break;
      case 'laborer': look = 'laborer'; break;
      case 'soldier': look = 'soldier'; break;
      case 'enemy': look = 'enemy'; break;
      case 'trader': look = 'cart'; break;
    }
    r.draw(a.get(`w_${look}_${wk.dir}_${frame}`), wx, wy, 1, light[0], light[1], light[2], 1);
  }

  // -------------------------------------------------------------------------

  private drawOverlay(city: City, x0: number, y0: number, x1: number, y1: number): void {
    const r = this.renderer;
    const w = city.world;
    const sp = this.atlas.get('ui_overlay');

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const i = w.idx(tx, ty);
        const col = this.overlayColor(city, i, tx, ty);
        if (!col) continue;
        const [wx, wy] = tileToWorld(tx, ty);
        r.draw(sp, wx, wy, 1, col[0], col[1], col[2], col[3]);
      }
    }
  }

  /** Colour for one tile under the active overlay, or null to leave it alone. */
  private overlayColor(city: City, i: number, tx: number, ty: number): [number, number, number, number] | null {
    const w = city.world;
    const heat = (v: number): [number, number, number, number] => {
      // Red (bad / low) through amber to green (good / high).
      const t = clamp(v, 0, 1);
      return t < 0.5
        ? [1, 0.25 + t * 1.3, 0.2, 0.45]
        : [1.6 - t * 1.4, 0.9, 0.28, 0.45];
    };

    switch (this.overlay) {
      case 'roads':
        return w.road[i] ? [0.4, 0.9, 1, 0.4] : null;
      case 'fertility':
        if (w.terrain[i] !== Terrain.Floodplain) return null;
        return heat(w.fertility[i] / 100);
      case 'desirability': {
        const d = w.desirability[i];
        if (d === 0) return null;
        return d > 0
          ? [0.3, 1, 0.45, clamp(d / 60, 0.08, 0.5)]
          : [1, 0.3, 0.28, clamp(-d / 25, 0.08, 0.5)];
      }
      default:
        break;
    }

    const id = w.building[i];
    if (id < 0) return null;
    const b = city.buildings[id];
    if (!b) return null;

    switch (this.overlay) {
      case 'fire':
        return b.fire > 4 ? heat(1 - b.fire / 110) : null;
      case 'damage':
        return b.damage > 4 ? heat(1 - b.damage / 110) : null;
      case 'workers': {
        const def = BUILDING_BY_ID[b.defId];
        if (!def.workers) return null;
        return heat(b.staffing);
      }
      default:
        break;
    }

    if (!b.house) return null;
    const h = b.house;
    switch (this.overlay) {
      case 'water':
        return h.services.water ? [0.3, 0.8, 1, 0.5] : h.services.wellWater ? [0.5, 0.9, 0.7, 0.42] : [1, 0.3, 0.3, 0.45];
      case 'religion': {
        const n = GOD_IDS.filter((g) => h.services[RELIGION_SERVICE[g]]).length;
        return heat(n / 5);
      }
      case 'education': {
        const n = (h.services.school ? 1 : 0) + (h.services.library ? 1 : 0);
        return heat(n / 2);
      }
      case 'entertainment': {
        const n = (h.services.booth ? 1 : 0) + (h.services.bandstand ? 1 : 0) +
          (h.services.pavilion ? 1 : 0) + (h.services.senet ? 1 : 0);
        return heat(n / 4);
      }
      case 'health':
        return heat(h.health / 100);
      case 'food': {
        let food = 0;
        for (const k of Object.keys(h.foods)) food += h.foods[k as never] ?? 0;
        return heat(clamp(food / Math.max(1, h.people * 1.2), 0, 1));
      }
      case 'tax':
        return h.taxFresh > 0 ? [0.3, 1, 0.5, 0.42] : [1, 0.35, 0.3, 0.45];
      case 'crime':
        return heat(1 - h.crime / 100);
      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------

  private drawCursor(city: City): void {
    const r = this.renderer;
    const a = this.atlas;
    const w = city.world;

    for (const t of this.previewTiles) {
      if (t < 0) continue;
      const [wx, wy] = tileToWorld(w.xOf(t), w.yOf(t));
      r.draw(a.get('ui_cursor_ok'), wx, wy, 1, 1, 1, 1, 0.75);
    }

    if (this.cursorTile < 0) return;
    const cx = w.xOf(this.cursorTile);
    const cy = w.yOf(this.cursorTile);
    const sp = a.get(this.cursorValid ? 'ui_cursor_ok' : 'ui_cursor_bad');
    for (let dy = 0; dy < this.cursorSize; dy++) {
      for (let dx = 0; dx < this.cursorSize; dx++) {
        if (!w.inBounds(cx + dx, cy + dy)) continue;
        const [wx, wy] = tileToWorld(cx + dx, cy + dy);
        r.draw(sp, wx, wy, 1, 1, 1, 1, 1);
      }
    }
  }

  // -------------------------------------------------------------------------

  /** Tile index under a CSS-pixel screen point, or -1. */
  pickTile(sx: number, sy: number, world: World): number {
    const [wx, wy] = this.camera.screenToWorld(sx, sy, this.renderer.viewW, this.renderer.viewH);
    const [ftx, fty] = worldToTile(wx, wy);
    const tx = Math.floor(ftx);
    const ty = Math.floor(fty);
    return world.inBounds(tx, ty) ? world.idx(tx, ty) : -1;
  }
}
