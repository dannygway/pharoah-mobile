/**
 * Game orchestration: the fixed-timestep loop, build interactions, mission goals and
 * saving.
 *
 * The simulation runs at a fixed rate independent of the display. On a 120Hz iPhone the
 * renderer draws every frame while the simulation takes as many fixed steps as it owes,
 * capped so that a background tab or a stall cannot produce a death spiral.
 */

import { clamp, money } from './core';
import { World } from './world';
import { City, Building, TradeRoute } from './sim';
import { Systems } from './systems';
import { Scene, OverlayId, worldToTile, tileToWorld } from './scene';
import { Renderer } from './gl';
import { Atlas, TILE_W, TILE_H } from './atlas';
import { Input } from './input';
import { AudioEngine } from './audio';
import { BUILDING_BY_ID, BuildingDef, GoodId, GOD_IDS } from './data';
import { TICKS_PER_MONTH, TICKS_PER_YEAR } from './consts';
import { Mission, missionById, MISSIONS } from './missions';

export const SIM_HZ = 30;
const SIM_DT = 1 / SIM_HZ;
export const SPEEDS = [0, 1, 2, 3, 5];

export type GameStatus = 'playing' | 'won' | 'lost';

export interface GoalProgress {
  label: string;
  current: number;
  target: number;
  met: boolean;
}

export const DEMOLISH = '__demolish';

export class Game {
  world: World;
  city: City;
  systems: Systems;
  scene: Scene;
  renderer: Renderer;
  input: Input;
  audio: AudioEngine;
  atlas: Atlas;

  mission: Mission;
  status: GameStatus = 'playing';
  /** Mission tick at which play began, so goals measure elapsed time. */
  startTick = 0;

  speedIndex = 1;
  /** Set while a menu is open, so the sim halts without changing the player's speed. */
  suspended = false;

  /** Building armed for placement, or null. */
  armed: string | null = null;
  /** Tiles painted during the current drag. */
  private dragTiles: number[] = [];
  private dragStart = -1;

  /** Called whenever something happened the UI should redraw for. */
  onChange: (() => void) | null = null;
  onStatusChange: ((s: GameStatus) => void) | null = null;

  private accumulator = 0;
  private lastFrame = 0;
  private rafId = 0;
  private running = false;
  private autosaveTimer = 0;

  constructor(canvas: HTMLCanvasElement, atlas: Atlas, audio: AudioEngine, missionId = 'nubt') {
    this.atlas = atlas;
    this.audio = audio;
    this.mission = missionById(missionId);
    this.renderer = new Renderer(canvas, atlas);
    this.scene = new Scene(atlas, this.renderer);

    this.world = new World(this.mission.mapSize, this.mission.mapSeed);
    this.city = new City(this.world, this.mission.mapSeed);
    this.systems = new Systems(this.city);

    this.input = new Input(canvas, this.scene.camera, {
      isBuilding: () => this.armed !== null,
      onCursorMove: (x, y) => this.updateCursor(x, y),
      onPaintStart: (x, y) => this.paintStart(x, y),
      onPaintMove: (x, y) => this.paintMove(x, y),
      onPaintEnd: () => this.paintEnd(),
      onTap: (x, y) => this.tap(x, y),
      onLongPress: (x, y) => this.inspect(x, y),
      onCancel: () => this.cancelDrag(),
    });

    this.setupMission();
  }

  // -------------------------------------------------------------------------
  // Mission setup
  // -------------------------------------------------------------------------

  setupMission(): void {
    const m = this.mission;
    this.world.generate({
      seed: m.mapSeed,
      riverWidth: m.riverWidth,
      floodplainWidth: m.floodplainWidth,
      rockiness: m.rockiness,
    });
    this.city.findEntryPoints();
    this.city.funds = m.startFunds;
    this.city.taxRate = m.taxRate;
    this.city.trade = m.routes.map((r) => ({ ...r, soldThisYear: {}, boughtThisYear: {} }));
    this.status = 'playing';
    this.startTick = 0;

    // Schedule the scripted events.
    for (const inv of m.invasions) {
      this.systems.scheduleInvasion(inv.year * TICKS_PER_YEAR, inv.enemy, inv.strength);
    }
    this.pendingRequests = m.requests.map((r) => ({ ...r, fired: false }));

    // Sensible default trade policy: export nothing, import nothing, until asked.
    this.systems.tradePolicy = {};

    // Point the camera at the middle of the floodplain near the entry point.
    if (this.city.entryTile >= 0) {
      this.scene.camera.centreOnTile(this.world.xOf(this.city.entryTile), this.world.yOf(this.city.entryTile));
    } else {
      this.scene.camera.centreOnTile(this.world.size / 2, this.world.size / 2);
    }
    this.scene.camera.tzoom = 1.1;
    this.scene.camera.zoom = 1.1;

    this.city.pushMessage(m.name, m.brief, 'info');
    this.city.pushMessage('Advice', m.hint, 'info');
    this.city.markDirty();
  }

  private pendingRequests: (Mission['requests'][number] & { fired: boolean })[] = [];

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(frame);
      const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.frame(dt, now / 1000);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame(dt: number, time: number): void {
    const speed = this.suspended || this.status !== 'playing' ? 0 : SPEEDS[this.speedIndex];

    if (speed > 0) {
      this.accumulator += dt * speed;
      // Never run more than a quarter second of simulation in one frame; if the device
      // cannot keep up, time dilates rather than the frame rate collapsing.
      const maxSteps = Math.ceil(SIM_HZ * 0.25 * speed);
      let steps = 0;
      while (this.accumulator >= SIM_DT && steps < maxSteps) {
        this.accumulator -= SIM_DT;
        this.city.step();
        this.systems.step();
        steps++;
      }
      if (this.accumulator > SIM_DT * 4) this.accumulator = 0;

      this.checkScriptedEvents();
      this.checkGoals();

      this.autosaveTimer += dt;
      if (this.autosaveTimer > 45) {
        this.autosaveTimer = 0;
        this.save('autosave');
      }
    }

    this.scene.camera.update(dt);
    this.input.viewW = this.renderer.viewW;
    this.input.viewH = this.renderer.viewH;

    this.scene.render(this.city, this.systems, time, dt);

    this.audio.update({
      floodLevel: this.city.floodLevel,
      population: this.city.population,
      season: this.city.season,
      danger: clamp(this.city.walkers.live.filter((i) => this.city.walkers.get(i)?.kind === 'enemy').length / 12, 0, 1),
    });
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.renderer.resize(cssW, cssH, dpr);
    this.input.viewW = cssW;
    this.input.viewH = cssH;
  }

  // -------------------------------------------------------------------------
  // Scripted mission events
  // -------------------------------------------------------------------------

  private checkScriptedEvents(): void {
    const year = this.city.year;
    for (const r of this.pendingRequests) {
      if (r.fired || year < r.year) continue;
      r.fired = true;
      this.systems.addRequest(r.good, r.amount, r.months);
      this.onChange?.();
    }
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  goalProgress(): GoalProgress[] {
    const g = this.mission.goals;
    const c = this.city;
    const out: GoalProgress[] = [];
    const add = (label: string, cur: number, target?: number) => {
      if (target === undefined) return;
      out.push({ label, current: Math.floor(cur), target, met: cur >= target });
    };
    add('Population', c.population, g.population);
    add('Culture', c.ratings.culture, g.culture);
    add('Prosperity', c.ratings.prosperity, g.prosperity);
    add('Monuments', c.ratings.monument, g.monument);
    add('Kingdom', c.ratings.kingdom, g.kingdom);
    add('Years survived', c.year, g.years);
    if (g.monuments) {
      for (const id of g.monuments) {
        const def = BUILDING_BY_ID[id];
        const done = c.liveBuildings.some((i) => {
          const b = c.buildings[i];
          return b?.defId === id && b.monument?.complete;
        });
        out.push({ label: def?.name ?? id, current: done ? 1 : 0, target: 1, met: done });
      }
    }
    return out;
  }

  private checkGoals(): void {
    if (this.status !== 'playing') return;
    const progress = this.goalProgress();
    if (progress.length && progress.every((p) => p.met)) {
      this.status = 'won';
      this.city.pushMessage(
        'Pharaoh is pleased',
        `You have met every objective set for ${this.mission.place}. Word of your success has reached the palace, and a greater city awaits you.`,
        'good',
      );
      this.audio.chime(true);
      this.onStatusChange?.('won');
      this.unlockNext();
      return;
    }

    // Losing takes real neglect: a city that empties out, or ruinous debt.
    if (this.city.funds < -4000) {
      this.fail('Your debts have ruined the city. Pharaoh has recalled you in disgrace.');
    } else if (this.city.year > 3 && this.city.population === 0 && this.city.stats.capacity > 0) {
      this.fail('Your city stands empty. Every last family has walked away.');
    }
  }

  private fail(why: string): void {
    this.status = 'lost';
    this.city.pushMessage('You have failed', why, 'bad');
    this.audio.chime(false);
    this.onStatusChange?.('lost');
  }

  private unlockNext(): void {
    const idx = MISSIONS.findIndex((m) => m.id === this.mission.id);
    if (idx >= 0 && idx < MISSIONS.length - 1) {
      const unlocked = new Set(loadUnlocked());
      unlocked.add(MISSIONS[idx + 1].id);
      try {
        localStorage.setItem('kemet.unlocked', JSON.stringify([...unlocked]));
      } catch { /* storage may be full or blocked; not fatal */ }
    }
  }

  // -------------------------------------------------------------------------
  // Build interaction
  // -------------------------------------------------------------------------

  arm(defId: string | null): void {
    this.armed = defId;
    this.scene.previewTiles.length = 0;
    if (defId) {
      const def = BUILDING_BY_ID[defId];
      this.scene.cursorSize = def?.size ?? 1;
    } else {
      this.scene.cursorTile = -1;
      this.scene.cursorSize = 1;
    }
    this.onChange?.();
  }

  /** Is this building available in the current mission? */
  isUnlocked(defId: string): boolean {
    const u = this.mission.unlocks;
    return u.length === 0 || u.includes(defId);
  }

  /** Can the player afford it, and does the mission allow it? */
  canAfford(defId: string): boolean {
    const def = BUILDING_BY_ID[defId];
    return def ? this.city.funds >= def.cost : false;
  }

  private updateCursor(sx: number, sy: number): void {
    const t = this.scene.pickTile(sx, sy, this.world);
    this.scene.cursorTile = t;
    if (t < 0 || !this.armed) return;

    if (this.armed === DEMOLISH) {
      this.scene.cursorSize = 1;
      this.scene.cursorValid = true;
      return;
    }
    const def = BUILDING_BY_ID[this.armed];
    if (!def) return;
    this.scene.cursorSize = def.size;
    const x = this.world.xOf(t);
    const y = this.world.yOf(t);
    if (def.id === 'road' || def.id === 'plaza') {
      this.scene.cursorValid =
        this.world.terrain[t] !== 0 && this.world.building[t] === -1 &&
        !(def.id === 'road' && this.world.road[t] === 1);
    } else {
      this.scene.cursorValid =
        this.world.canPlace(x, y, def.size, def.terrain, def.terrain === 'rock') &&
        this.city.funds >= def.cost;
    }
  }

  /** Buildings the player paints in a stroke rather than placing one at a time. */
  private isPaintable(defId: string): boolean {
    return defId === 'road' || defId === 'plaza' || defId === 'wall' ||
      defId === 'garden' || defId === 'house' || defId === DEMOLISH;
  }

  private paintStart(sx: number, sy: number): void {
    const t = this.scene.pickTile(sx, sy, this.world);
    this.dragStart = t;
    this.dragTiles.length = 0;
    if (t >= 0 && this.armed && this.isPaintable(this.armed)) {
      this.dragTiles.push(t);
      this.scene.previewTiles = this.dragTiles;
    }
  }

  private paintMove(sx: number, sy: number): void {
    if (!this.armed || !this.isPaintable(this.armed)) return;
    const t = this.scene.pickTile(sx, sy, this.world);
    if (t < 0) return;
    if (this.armed === 'road' || this.armed === 'plaza' || this.armed === 'wall') {
      // Roads snap to an L-shaped run from the start tile, which is far easier to
      // control with a thumb than a freehand trail.
      this.dragTiles = this.lShape(this.dragStart, t);
    } else if (!this.dragTiles.includes(t)) {
      this.dragTiles.push(t);
    }
    this.scene.previewTiles = this.dragTiles;
  }

  /** Tiles along an L from a to b, going in the longer axis first. */
  private lShape(a: number, b: number): number[] {
    if (a < 0 || b < 0) return [];
    const w = this.world;
    const ax = w.xOf(a), ay = w.yOf(a);
    const bx = w.xOf(b), by = w.yOf(b);
    const out: number[] = [];
    const dx = Math.abs(bx - ax);
    const dy = Math.abs(by - ay);
    const stepX = Math.sign(bx - ax);
    const stepY = Math.sign(by - ay);
    if (dx >= dy) {
      for (let x = ax; x !== bx + stepX && stepX !== 0; x += stepX) out.push(w.idx(x, ay));
      if (stepX === 0) out.push(w.idx(ax, ay));
      for (let y = ay; y !== by + stepY && stepY !== 0; y += stepY) out.push(w.idx(bx, y));
    } else {
      for (let y = ay; y !== by + stepY && stepY !== 0; y += stepY) out.push(w.idx(ax, y));
      if (stepY === 0) out.push(w.idx(ax, ay));
      for (let x = ax; x !== bx + stepX && stepX !== 0; x += stepX) out.push(w.idx(x, by));
    }
    // Deduplicate while preserving order.
    return [...new Set(out)];
  }

  private paintEnd(): void {
    if (!this.armed) return;
    const armed = this.armed;

    if (this.isPaintable(armed) && this.dragTiles.length > 0) {
      let placed = 0;
      for (const t of this.dragTiles) {
        const x = this.world.xOf(t);
        const y = this.world.yOf(t);
        if (armed === DEMOLISH) {
          if (this.city.demolish(x, y, true)) placed++;
        } else if (this.city.place(armed, x, y) !== -1) {
          placed++;
        }
      }
      if (placed) {
        armed === DEMOLISH ? this.audio.demolish() : this.audio.build();
      } else {
        this.audio.error();
      }
    } else if (this.scene.cursorTile >= 0) {
      const x = this.world.xOf(this.scene.cursorTile);
      const y = this.world.yOf(this.scene.cursorTile);
      if (armed === DEMOLISH) {
        this.city.demolish(x, y, true) ? this.audio.demolish() : this.audio.error();
      } else {
        const id = this.city.place(armed, x, y);
        id !== -1 ? this.audio.build() : this.audio.error();
      }
    }

    this.dragTiles = [];
    this.scene.previewTiles = [];
    this.dragStart = -1;
    this.city.markDirty();
    this.onChange?.();
  }

  private cancelDrag(): void {
    this.dragTiles = [];
    this.scene.previewTiles = [];
    this.dragStart = -1;
  }

  private tap(sx: number, sy: number): void {
    const t = this.scene.pickTile(sx, sy, this.world);
    if (t < 0) {
      this.scene.selected = -1;
      this.onChange?.();
      return;
    }
    const id = this.world.building[t];
    this.scene.selected = id;
    this.audio.tap();
    this.onChange?.();
  }

  private inspect(sx: number, sy: number): void {
    const t = this.scene.pickTile(sx, sy, this.world);
    if (t < 0) return;
    const id = this.world.building[t];
    this.scene.selected = id;
    this.onInspect?.(id, t);
    this.onChange?.();
  }

  onInspect: ((buildingId: number, tile: number) => void) | null = null;

  selectedBuilding(): Building | null {
    return this.scene.selected >= 0 ? this.city.buildings[this.scene.selected] ?? null : null;
  }

  centreOnTile(tile: number): void {
    if (tile < 0) return;
    this.scene.camera.centreOnTile(this.world.xOf(tile), this.world.yOf(tile));
  }

  setOverlay(o: OverlayId): void {
    this.scene.overlay = o;
    this.onChange?.();
  }

  cycleSpeed(): void {
    this.speedIndex = (this.speedIndex + 1) % SPEEDS.length;
    this.onChange?.();
  }

  setSpeed(i: number): void {
    this.speedIndex = clamp(i, 0, SPEEDS.length - 1);
    this.onChange?.();
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  save(slot = 'manual'): boolean {
    try {
      const data = this.serialize();
      localStorage.setItem(`kemet.save.${slot}`, JSON.stringify(data));
      localStorage.setItem('kemet.lastSlot', slot);
      return true;
    } catch (e) {
      console.warn('Save failed', e);
      return false;
    }
  }

  serialize(): any {
    const c = this.city;
    return {
      version: 3,
      mission: this.mission.id,
      status: this.status,
      speedIndex: this.speedIndex,
      savedAt: Date.now(),
      world: this.world.serialize(),
      city: {
        tick: c.tick, funds: c.funds, savings: c.savings, salary: c.salary,
        taxRate: c.taxRate, population: c.population,
        godMood: c.godMood, godFestival: c.godFestival, ratings: c.ratings,
        floodLevel: c.floodLevel, floodQuality: c.floodQuality, nextFloodQuality: c.nextFloodQuality,
        messages: c.messages.slice(0, 30), trade: c.trade, requests: c.requests,
        invasions: c.invasions, entryTile: c.entryTile, exitTile: c.exitTile,
        laborPriority: c.laborPriority, rngState: c.rng.state,
      },
      buildings: c.liveBuildings.map((id) => {
        const b = c.buildings[id]!;
        return {
          id: b.id, defId: b.defId, x: b.x, y: b.y, built: b.built,
          progress: b.progress, store: b.store, fire: b.fire, damage: b.damage,
          enabled: b.enabled, variant: b.variant, age: b.age,
          house: b.house, monument: b.monument, garrison: b.garrison, orders: b.orders,
        };
      }),
      systems: {
        tradePolicy: this.systems.tradePolicy,
        tradeLimit: this.systems.tradeLimit,
        festival: this.systems.festival,
      },
      pendingRequests: this.pendingRequests,
      camera: {
        x: this.scene.camera.tx, y: this.scene.camera.ty, zoom: this.scene.camera.tzoom,
      },
    };
  }

  /** Restore a save into this game instance. */
  load(data: any): boolean {
    try {
      if (!data || data.version !== 3) return false;
      this.mission = missionById(data.mission);
      this.world = World.deserialize(data.world);
      this.city = new City(this.world, this.mission.mapSeed);
      this.systems = new Systems(this.city);

      const c = this.city;
      const s = data.city;
      Object.assign(c, {
        tick: s.tick, funds: s.funds, savings: s.savings, salary: s.salary,
        taxRate: s.taxRate, population: s.population, godMood: s.godMood,
        godFestival: s.godFestival, ratings: s.ratings, floodLevel: s.floodLevel,
        floodQuality: s.floodQuality, nextFloodQuality: s.nextFloodQuality,
        messages: s.messages ?? [], trade: s.trade ?? [], requests: s.requests ?? [],
        invasions: s.invasions ?? [], entryTile: s.entryTile, exitTile: s.exitTile,
        laborPriority: s.laborPriority ?? c.laborPriority,
      });
      c.rng.state = s.rngState ?? 1;

      // Rebuild buildings. Walkers are transient and simply respawn.
      let maxId = -1;
      for (const b of data.buildings) maxId = Math.max(maxId, b.id);
      c.buildings = new Array(maxId + 1).fill(null);
      c.liveBuildings = [];
      for (const bs of data.buildings) {
        const def = BUILDING_BY_ID[bs.defId];
        if (!def) continue;
        const b: Building = {
          id: bs.id, defId: bs.defId, x: bs.x, y: bs.y, size: def.size,
          built: bs.built, workers: 0, staffing: 0, progress: bs.progress,
          store: bs.store ?? {}, fire: bs.fire, damage: bs.damage,
          walkerCooldown: 0, walkers: [], hasRoad: false, enabled: bs.enabled !== false,
          house: bs.house, monument: bs.monument, garrison: bs.garrison, orders: bs.orders,
          variant: bs.variant ?? 0, age: bs.age ?? 0,
        };
        c.buildings[b.id] = b;
        c.liveBuildings.push(b.id);
        for (let dy = 0; dy < def.size; dy++) {
          for (let dx = 0; dx < def.size; dx++) {
            if (this.world.inBounds(b.x + dx, b.y + dy)) {
              this.world.building[this.world.idx(b.x + dx, b.y + dy)] = b.id;
            }
          }
        }
        (c as any).countsByDef?.set?.(b.defId, (c.countOf(b.defId) ?? 0) + 1);
      }
      // Re-derive road access and counts through the public path.
      for (const id of c.liveBuildings) {
        const b = c.buildings[id]!;
        c.refreshRoadAccess(b);
      }
      c.recomputeDesirability();
      this.world.applyFlood(c.floodLevel);

      this.systems.tradePolicy = data.systems?.tradePolicy ?? {};
      this.systems.tradeLimit = data.systems?.tradeLimit ?? {};
      this.systems.festival = data.systems?.festival ?? null;
      this.pendingRequests = data.pendingRequests ?? [];
      this.status = data.status ?? 'playing';
      this.speedIndex = data.speedIndex ?? 1;

      this.scene.selected = -1;
      if (data.camera) {
        this.scene.camera.tx = this.scene.camera.x = data.camera.x;
        this.scene.camera.ty = this.scene.camera.y = data.camera.y;
        this.scene.camera.tzoom = this.scene.camera.zoom = data.camera.zoom;
      }
      // Point the input layer at the restored camera.
      (this.input as any).cam = this.scene.camera;
      this.onChange?.();
      return true;
    } catch (e) {
      console.warn('Load failed', e);
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Save-slot helpers
// ---------------------------------------------------------------------------

export interface SaveInfo {
  slot: string;
  mission: string;
  place: string;
  year: number;
  population: number;
  savedAt: number;
}

export function listSaves(): SaveInfo[] {
  const out: SaveInfo[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('kemet.save.')) continue;
    try {
      const data = JSON.parse(localStorage.getItem(key)!);
      const m = missionById(data.mission);
      out.push({
        slot: key.slice('kemet.save.'.length),
        mission: data.mission,
        place: m.place,
        year: Math.floor((data.city?.tick ?? 0) / TICKS_PER_YEAR),
        population: data.city?.population ?? 0,
        savedAt: data.savedAt ?? 0,
      });
    } catch { /* corrupt slot: skip it rather than blocking the menu */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function readSave(slot: string): any | null {
  try {
    const raw = localStorage.getItem(`kemet.save.${slot}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function deleteSave(slot: string): void {
  try {
    localStorage.removeItem(`kemet.save.${slot}`);
  } catch { /* nothing to do */ }
}

export function loadUnlocked(): string[] {
  try {
    const raw = localStorage.getItem('kemet.unlocked');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) && arr.length ? arr : [MISSIONS[0].id];
  } catch {
    return [MISSIONS[0].id];
  }
}
