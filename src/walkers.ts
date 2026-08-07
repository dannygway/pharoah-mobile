/**
 * Walkers.
 *
 * A Pharaoh city is not a spreadsheet with pictures — it works because little people
 * walk out of buildings, down roads, past houses, and hand over a service. Get the
 * roads wrong and the whole city stalls. That model is reproduced faithfully here:
 *
 *  - Roamers wander the road network semi-randomly and service everything they pass.
 *  - Carts and buyers path deliberately between buildings.
 *  - Immigrants walk in from the map edge before anyone is actually housed.
 *
 * Positions are kept in tile space as floats so the renderer can interpolate smoothly
 * regardless of the simulation rate.
 */

import { clamp } from './core';
import {
  BuildingDef, GoodId, GOODS, ServiceId, FOOD_IDS, HOUSEHOLD_GOODS, RELIGION_SERVICE, GOD_IDS,
} from './data';
import { SERVICE_DURATION, TICKS_PER_TILE } from './consts';
import type { Building, City } from './sim';

export type WalkerKind =
  | 'service'    // roams, delivers a service to houses it passes
  | 'seller'     // bazaar seller: roams, delivers food and goods
  | 'buyer'      // bazaar buyer: fetches stock from a granary or storage yard
  | 'cart'       // producer -> storage
  | 'supply'     // storage -> consumer workshop / monument
  | 'immigrant'
  | 'emigrant'
  | 'laborer'    // work camp -> monument
  | 'trader'     // caravan or ship arriving to trade
  | 'soldier'
  | 'enemy'
  | 'protester'; // unemployed / hungry, purely cosmetic warning sign

export interface Walker {
  id: number;
  alive: boolean;
  kind: WalkerKind;
  /** Building that spawned this walker, or -1. */
  home: number;
  /** Building this walker is heading to, or -1. */
  target: number;

  tile: number;
  prevTile: number;
  nextTile: number;
  /** 0..1 across the current tile. */
  t: number;
  speed: number;

  /** Interpolated tile-space position, maintained for the renderer. */
  px: number;
  py: number;
  /** 0=NE 1=SE 2=SW 3=NW, for sprite selection. */
  dir: number;

  path: Int32Array | null;
  pathIdx: number;

  /** Roaming budget in tiles. */
  roamLeft: number;
  returning: boolean;

  service?: ServiceId;
  /** Extra services delivered by the same figure (temple complexes). */
  services?: ServiceId[];
  cargo: Partial<Record<GoodId, number>>;
  /** People carried by an immigrant / emigrant. */
  people: number;
  /** Combat. */
  hp: number;
  attack: number;

  /** Cosmetic. */
  variant: number;
  /** Ticks lived, used for bobbing animation and lifetime caps. */
  age: number;
  maxAge: number;
}

const MAX_WALKERS = 900;

export class WalkerSystem {
  private city: City;
  walkers: (Walker | null)[] = [];
  private free: number[] = [];
  /** Dense list of live walker ids, for iteration and rendering. */
  live: number[] = [];

  constructor(city: City) {
    this.city = city;
  }

  // -------------------------------------------------------------------------
  // Allocation
  // -------------------------------------------------------------------------

  private alloc(): Walker | null {
    if (this.live.length >= MAX_WALKERS) return null;
    let id = this.free.pop();
    if (id === undefined) {
      id = this.walkers.length;
      this.walkers.push(null);
    }
    const w: Walker = {
      id, alive: true, kind: 'service', home: -1, target: -1,
      tile: 0, prevTile: 0, nextTile: 0, t: 0, speed: 1,
      px: 0, py: 0, dir: 1,
      path: null, pathIdx: 0, roamLeft: 0, returning: false,
      cargo: {}, people: 0, hp: 0, attack: 0,
      variant: this.city.rng.int(1000), age: 0, maxAge: 20000,
    };
    this.walkers[id] = w;
    this.live.push(id);
    return w;
  }

  kill(id: number): void {
    const w = this.walkers[id];
    if (!w || !w.alive) return;
    w.alive = false;
    const b = w.home >= 0 ? this.city.buildings[w.home] : null;
    if (b) {
      const k = b.walkers.indexOf(id);
      if (k >= 0) b.walkers.splice(k, 1);
    }
    this.walkers[id] = null;
    this.free.push(id);
    const li = this.live.indexOf(id);
    if (li >= 0) this.live.splice(li, 1);
  }

  get(id: number): Walker | null {
    return this.walkers[id];
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  private placeAtEntrance(w: Walker, b: Building): boolean {
    const entrance = this.city.world.roadEntrance(b.x, b.y, b.size);
    if (entrance < 0) return false;
    w.tile = entrance;
    w.prevTile = entrance;
    w.nextTile = entrance;
    w.px = this.city.world.xOf(entrance) + 0.5;
    w.py = this.city.world.yOf(entrance) + 0.5;
    return true;
  }

  /** A roaming service walker (priest, water carrier, teacher, tax collector...). */
  spawnFrom(b: Building, def: BuildingDef): boolean {
    if (!def.service && def.id !== 'bazaar') return false;
    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, b)) {
      this.kill(w.id);
      return false;
    }
    w.home = b.id;
    w.kind = def.id === 'bazaar' ? 'seller' : 'service';
    w.service = def.service;
    w.services = def.services;
    w.roamLeft = def.walkerRange ?? 20;
    w.speed = 1;
    w.maxAge = (def.walkerRange ?? 20) * TICKS_PER_TILE * 3 + 400;

    if (w.kind === 'seller') {
      // The seller carries a real load, not a token one. A basket of twenty-four per
      // good, leaving every couple of months, works out at well under what a district
      // of eighty people eats — the bazaar would sit on full shelves while the houses
      // around it reported no food, which is a supply chain that looks connected on
      // the map and starves the city anyway.
      for (const g of [...FOOD_IDS, ...HOUSEHOLD_GOODS]) {
        const have = b.store[g] ?? 0;
        if (have <= 0) continue;
        const take = Math.min(have, 60);
        b.store[g] = have - take;
        w.cargo[g] = take;
      }
      if (!Object.keys(w.cargo).length) {
        this.kill(w.id);
        return false;
      }
    }

    b.walkers.push(w.id);
    return true;
  }

  /** Producer pushes finished goods to the nearest accepting store. */
  spawnCart(b: Building, good: GoodId, qty: number): boolean {
    const store = this.findStorageFor(b, good, true);
    if (store < 0) return false;
    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, b)) {
      this.kill(w.id);
      return false;
    }
    const dest = this.city.buildings[store]!;
    const path = this.pathToBuilding(w.tile, dest);
    if (!path) {
      this.kill(w.id);
      return false;
    }
    w.home = b.id;
    w.kind = 'cart';
    w.target = store;
    w.cargo[good] = qty;
    w.path = path;
    w.pathIdx = 0;
    w.speed = 0.85;
    w.maxAge = path.length * TICKS_PER_TILE * 4 + 600;
    b.walkers.push(w.id);
    return true;
  }

  /** Bazaar sends a buyer to fetch stock. */
  spawnBuyer(b: Building): boolean {
    // Prefer whatever the bazaar is most short of.
    const wants: GoodId[] = [...FOOD_IDS, ...HOUSEHOLD_GOODS];
    let bestStore = -1;
    let bestGood: GoodId | null = null;
    let bestQty = 0;
    for (const g of wants) {
      const s = this.findStorageWith(b, g);
      if (s < 0) continue;
      const qty = this.city.buildings[s]!.store[g] ?? 0;
      // Weight food heavily — a bazaar with no food starves a district.
      const weight = GOODS[g].kind === 'food' ? 2.2 : 1;
      if (qty * weight > bestQty) {
        bestQty = qty * weight;
        bestStore = s;
        bestGood = g;
      }
    }
    if (bestStore < 0 || !bestGood) return false;

    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, b)) {
      this.kill(w.id);
      return false;
    }
    const dest = this.city.buildings[bestStore]!;
    const path = this.pathToBuilding(w.tile, dest);
    if (!path) {
      this.kill(w.id);
      return false;
    }
    w.home = b.id;
    w.kind = 'buyer';
    w.target = bestStore;
    w.path = path;
    w.pathIdx = 0;
    w.speed = 1;
    w.maxAge = path.length * TICKS_PER_TILE * 4 + 800;
    b.walkers.push(w.id);
    return true;
  }

  /** Storage yard sends raw materials to a workshop that has run dry. */
  spawnSupply(from: Building, to: Building, good: GoodId, qty: number): boolean {
    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, from)) {
      this.kill(w.id);
      return false;
    }
    const path = this.pathToBuilding(w.tile, to);
    if (!path) {
      this.kill(w.id);
      return false;
    }
    from.store[good] = (from.store[good] ?? 0) - qty;
    w.home = from.id;
    w.kind = 'supply';
    w.target = to.id;
    w.cargo[good] = qty;
    w.path = path;
    w.pathIdx = 0;
    w.speed = 0.85;
    w.maxAge = path.length * TICKS_PER_TILE * 4 + 600;
    from.walkers.push(w.id);
    return true;
  }

  /** Work camp sends labour to a monument site. */
  spawnLaborer(camp: Building, monument: Building): boolean {
    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, camp)) {
      this.kill(w.id);
      return false;
    }
    const path = this.pathToBuilding(w.tile, monument);
    if (!path) {
      this.kill(w.id);
      return false;
    }
    w.home = camp.id;
    w.kind = 'laborer';
    w.target = monument.id;
    w.path = path;
    w.pathIdx = 0;
    w.speed = 0.8;
    w.maxAge = path.length * TICKS_PER_TILE * 4 + 800;
    camp.walkers.push(w.id);
    return true;
  }

  spawnImmigrant(lot: Building): boolean {
    const city = this.city;
    if (city.entryTile < 0) return false;
    const w = this.alloc();
    if (!w) return false;

    // Immigrants appear at the edge of the city's road network nearest the map entry
    // and walk in from there.
    const start = this.arrivalRoadFor(lot, city.entryTile);
    if (start < 0) {
      // No roads at all yet: let the very first settlers appear directly.
      this.kill(w.id);
      const cap = 5;
      if (lot.house && lot.house.people < cap) {
        lot.house.people += 1;
        city.population += 1;
      }
      return true;
    }
    const path = this.pathToBuilding(start, lot);
    if (!path) {
      this.kill(w.id);
      return false;
    }
    w.tile = start;
    w.prevTile = start;
    w.nextTile = start;
    w.px = city.world.xOf(start) + 0.5;
    w.py = city.world.yOf(start) + 0.5;
    w.kind = 'immigrant';
    w.home = -1;
    w.target = lot.id;
    w.people = city.rng.range(2, 5);
    w.path = path;
    w.pathIdx = 0;
    w.speed = 0.9;
    w.maxAge = path.length * TICKS_PER_TILE * 5 + 1200;
    return true;
  }

  spawnEmigrant(from: Building, people: number): boolean {
    const city = this.city;
    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, from)) {
      this.kill(w.id);
      return false;
    }
    w.kind = 'emigrant';
    w.people = people;
    w.roamLeft = 60;
    w.speed = 1;
    w.maxAge = 4000;
    // Leave by whatever edge of this district's road network is closest to the way out.
    const exitRoad = city.exitTile >= 0 ? this.arrivalRoadFor(from, city.exitTile) : -1;
    if (exitRoad >= 0 && exitRoad !== w.tile) {
      const path = city.world.findRoadPath(w.tile, (i) => i === exitRoad, 2000);
      if (path) {
        w.path = path;
        w.pathIdx = 0;
      }
    }
    return true;
  }

  spawnSoldier(fort: Building, tx: number, ty: number): boolean {
    const w = this.alloc();
    if (!w) return false;
    if (!this.placeAtEntrance(w, fort)) {
      this.kill(w.id);
      return false;
    }
    w.kind = 'soldier';
    w.home = fort.id;
    w.hp = 100;
    w.attack = 10;
    w.speed = 1.1;
    w.maxAge = 100000;
    const goal = this.city.world.idx(clamp(tx, 0, this.city.world.size - 1), clamp(ty, 0, this.city.world.size - 1));
    const path = this.city.world.findRoadPath(w.tile, (i) => i === goal, 2000);
    if (path) {
      w.path = path;
      w.pathIdx = 0;
    }
    fort.walkers.push(w.id);
    return true;
  }

  spawnEnemy(tile: number, strength: number): Walker | null {
    const w = this.alloc();
    if (!w) return null;
    w.kind = 'enemy';
    w.tile = tile;
    w.prevTile = tile;
    w.nextTile = tile;
    w.px = this.city.world.xOf(tile) + 0.5;
    w.py = this.city.world.yOf(tile) + 0.5;
    w.hp = 60 + strength * 4;
    w.attack = 6 + strength;
    w.speed = 0.7;
    w.maxAge = 200000;
    return w;
  }

  spawnTrader(tile: number, kind: 'land' | 'sea', cargo: Partial<Record<GoodId, number>>, target: number): boolean {
    const w = this.alloc();
    if (!w) return false;
    w.kind = 'trader';
    w.tile = tile;
    w.prevTile = tile;
    w.nextTile = tile;
    w.px = this.city.world.xOf(tile) + 0.5;
    w.py = this.city.world.yOf(tile) + 0.5;
    w.cargo = cargo;
    w.target = target;
    w.speed = kind === 'sea' ? 1.2 : 0.8;
    w.maxAge = 30000;
    const dest = this.city.buildings[target];
    if (dest) {
      const path = this.pathToBuilding(tile, dest);
      if (path) {
        w.path = path;
        w.pathIdx = 0;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private pathToBuilding(from: number, dest: Building): Int32Array | null {
    const w = this.city.world;
    const entrance = w.roadEntrance(dest.x, dest.y, dest.size);
    if (entrance < 0) return null;
    if (from === entrance) return new Int32Array([from]);
    return w.findRoadPath(from, (i) => i === entrance, 3000);
  }

  /**
   * The tile on `dest`'s own road network that lies closest to `from`.
   *
   * Simply taking the nearest road tile to the map edge is wrong and was a real bug:
   * if that tile happens to sit on a disconnected road fragment — a spur out to some
   * farms, say — no path to the destination exists and immigration silently stops
   * forever. Searching within the destination's connected component guarantees the
   * walk is possible, and still puts the walker at the edge of the city facing the
   * direction they came from.
   */
  private arrivalRoadFor(dest: Building, from: number): number {
    const w = this.city.world;
    const entrance = w.roadEntrance(dest.x, dest.y, dest.size);
    if (entrance < 0) return -1;
    const ex = w.xOf(from);
    const ey = w.yOf(from);
    let best = entrance;
    let bestD = Math.abs(w.xOf(entrance) - ex) + Math.abs(w.yOf(entrance) - ey);
    w.forEachRoadInComponent(entrance, (i) => {
      const d = Math.abs(w.xOf(i) - ex) + Math.abs(w.yOf(i) - ey);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Closest road tile to an arbitrary tile, searched outward in rings. */
  private nearestRoadTo(tile: number): number {
    const w = this.city.world;
    const sx = w.xOf(tile);
    const sy = w.yOf(tile);
    // Search the whole map: a city built far from the entry point still has to be
    // reachable, and this only runs when a walker is created.
    for (let r = 0; r < w.size; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (!w.inBounds(x, y)) continue;
          const i = w.idx(x, y);
          if (w.road[i]) return i;
        }
      }
    }
    return -1;
  }

  /** A store that will accept `good` and has room. */
  private findStorageFor(from: Building, good: GoodId, needRoom: boolean): number {
    const city = this.city;
    const isFood = GOODS[good].kind === 'food';
    const wantDef = isFood ? 'granary' : 'storage_yard';
    let best = -1;
    let bestD = Infinity;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b || b.defId !== wantDef || !b.hasRoad || !b.built) continue;
      if (b.orders?.[good] === 'refuse') continue;
      const def = city.def(b);
      if (needRoom) {
        const used = Object.values(b.store).reduce((a: number, v) => a + (v ?? 0), 0);
        if (used >= (def.storage ?? 0)) continue;
      }
      const d = Math.abs(b.x - from.x) + Math.abs(b.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /**
   * Can this producer actually walk its output to a store? Used to tell the player
   * why a workshop is silently piling up stock — almost always because the storage
   * yard is on a road network that does not connect to it.
   */
  canReachStorage(b: Building, good: GoodId): boolean {
    const store = this.findStorageFor(b, good, true);
    if (store < 0) return false;
    const entrance = this.city.world.roadEntrance(b.x, b.y, b.size);
    if (entrance < 0) return false;
    return this.pathToBuilding(entrance, this.city.buildings[store]!) !== null;
  }

  /** A store that currently holds `good`. */
  private findStorageWith(from: Building, good: GoodId): number {
    const city = this.city;
    const isFood = GOODS[good].kind === 'food';
    const wantDef = isFood ? 'granary' : 'storage_yard';
    let best = -1;
    let bestD = Infinity;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b || b.defId !== wantDef || !b.hasRoad || !b.built) continue;
      if ((b.store[good] ?? 0) < 4) continue;
      const d = Math.abs(b.x - from.x) + Math.abs(b.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  step(): void {
    // Iterate over a copy of the id list: walkers may die mid-step.
    const ids = this.live.slice();
    for (let k = 0; k < ids.length; k++) {
      const w = this.walkers[ids[k]];
      if (w?.alive) this.stepWalker(w);
    }
  }

  private stepWalker(w: Walker): void {
    w.age++;
    if (w.age > w.maxAge) {
      this.arriveHomeOrDie(w);
      return;
    }

    // Advance across the current tile.
    if (w.tile !== w.nextTile) {
      w.t += w.speed / TICKS_PER_TILE;
      if (w.t >= 1) {
        w.t = 0;
        w.prevTile = w.tile;
        w.tile = w.nextTile;
        this.onEnterTile(w);
      }
    } else {
      // Need a new destination tile.
      this.chooseNextTile(w);
    }

    // Interpolated render position.
    const world = this.city.world;
    const ax = world.xOf(w.tile) + 0.5;
    const ay = world.yOf(w.tile) + 0.5;
    if (w.nextTile !== w.tile) {
      const bx = world.xOf(w.nextTile) + 0.5;
      const by = world.yOf(w.nextTile) + 0.5;
      w.px = ax + (bx - ax) * w.t;
      w.py = ay + (by - ay) * w.t;
      const ddx = bx - ax;
      const ddy = by - ay;
      w.dir = ddx > 0.1 ? 1 : ddx < -0.1 ? 3 : ddy > 0.1 ? 2 : 0;
    } else {
      w.px = ax;
      w.py = ay;
    }
  }

  private chooseNextTile(w: Walker): void {
    // Following a computed path?
    if (w.path && w.pathIdx < w.path.length - 1) {
      w.pathIdx++;
      w.nextTile = w.path[w.pathIdx];
      return;
    }
    if (w.path && w.pathIdx >= w.path.length - 1) {
      w.path = null;
      this.onPathComplete(w);
      return;
    }

    // Roaming.
    if (w.kind === 'service' || w.kind === 'seller' || w.kind === 'emigrant' || w.kind === 'protester') {
      if (w.roamLeft <= 0) {
        this.arriveHomeOrDie(w);
        return;
      }
      const next = this.pickRoamTile(w);
      if (next < 0) {
        this.arriveHomeOrDie(w);
        return;
      }
      w.nextTile = next;
      w.roamLeft--;
      return;
    }

    if (w.kind === 'enemy') {
      this.stepEnemy(w);
      return;
    }
    if (w.kind === 'soldier') {
      // Idle at post.
      return;
    }
    this.arriveHomeOrDie(w);
  }

  /**
   * The roaming rule. A walker will not immediately double back, prefers to keep going
   * straight, and otherwise picks at random. Roadblocks are impassable to roamers but
   * not to walkers following a path, which is exactly how districts get sealed off.
   */
  private pickRoamTile(w: Walker): number {
    const world = this.city.world;
    const nb = new Int32Array(4);
    const n = world.roadNeighbours(w.tile, nb);
    if (n === 0) return -1;

    const options: number[] = [];
    const weights: number[] = [];
    const straightDx = world.xOf(w.tile) - world.xOf(w.prevTile);
    const straightDy = world.yOf(w.tile) - world.yOf(w.prevTile);

    for (let k = 0; k < n; k++) {
      const cand = nb[k];
      if (this.isRoadblock(cand)) continue;
      let weight = 1;
      if (cand === w.prevTile) weight = 0.08; // strongly avoid backtracking
      else {
        const dx = world.xOf(cand) - world.xOf(w.tile);
        const dy = world.yOf(cand) - world.yOf(w.tile);
        if (dx === straightDx && dy === straightDy) weight = 3.2; // keep going
      }
      options.push(cand);
      weights.push(weight);
    }
    if (!options.length) {
      // Dead end: turning around is allowed rather than getting stuck.
      return nb[0];
    }
    let total = 0;
    for (const x of weights) total += x;
    let r = this.city.rng.next() * total;
    for (let i = 0; i < options.length; i++) {
      r -= weights[i];
      if (r <= 0) return options[i];
    }
    return options[options.length - 1];
  }

  private isRoadblock(tile: number): boolean {
    const id = this.city.world.building[tile];
    if (id < 0) return false;
    const b = this.city.buildings[id];
    return b?.defId === 'roadblock';
  }

  /** Called when a walker steps onto a new tile. */
  private onEnterTile(w: Walker): void {
    if (w.kind === 'service') this.applyService(w);
    else if (w.kind === 'seller') this.applySale(w);
    else if (w.kind === 'enemy') this.enemyAttackAdjacent(w);
  }

  /** Deliver this walker's service to every house adjacent to the current tile. */
  private applyService(w: Walker): void {
    const city = this.city;
    const world = city.world;
    const x = world.xOf(w.tile);
    const y = world.yOf(w.tile);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const px = x + dx;
        const py = y + dy;
        if (!world.inBounds(px, py)) continue;
        const id = world.building[world.idx(px, py)];
        if (id < 0) continue;
        const b = city.buildings[id];
        if (!b) continue;

        if (w.service === 'fire') {
          b.fire = Math.max(0, b.fire - 45);
          continue;
        }
        if (w.service === 'architect') {
          b.damage = Math.max(0, b.damage - 45);
          continue;
        }
        if (!b.house) continue;
        if (w.service === 'tax') {
          b.house.taxFresh = SERVICE_DURATION;
          continue;
        }
        if (w.service === 'magistrate') {
          b.house.crime = Math.max(0, b.house.crime - 20);
          continue;
        }
        if (w.service) b.house.services[w.service] = SERVICE_DURATION;
        if (w.services) for (const s of w.services) b.house.services[s] = SERVICE_DURATION;
      }
    }
  }

  /** A bazaar seller hands food and goods to houses along the road. */
  private applySale(w: Walker): void {
    const city = this.city;
    const world = city.world;
    const x = world.xOf(w.tile);
    const y = world.yOf(w.tile);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const px = x + dx;
        const py = y + dy;
        if (!world.inBounds(px, py)) continue;
        const id = world.building[world.idx(px, py)];
        if (id < 0) continue;
        const b = city.buildings[id];
        if (!b?.house || b.house.people <= 0) continue;
        const h = b.house;

        for (const g of Object.keys(w.cargo) as GoodId[]) {
          const have = w.cargo[g] ?? 0;
          if (have <= 0) continue;
          const isFood = GOODS[g].kind === 'food';
          const bin = isFood ? h.foods : h.goods;
          const cap = isFood ? h.people * 1.6 : h.people * 0.9;
          const cur = bin[g] ?? 0;
          if (cur >= cap) continue;
          const give = Math.min(have, cap - cur, 4);
          bin[g] = cur + give;
          w.cargo[g] = have - give;
          if (w.cargo[g]! <= 0.001) delete w.cargo[g];
        }
      }
    }
    if (!Object.keys(w.cargo).length) w.roamLeft = Math.min(w.roamLeft, 3);
  }

  /** Called when a path-following walker reaches its destination. */
  private onPathComplete(w: Walker): void {
    const city = this.city;
    const dest = w.target >= 0 ? city.buildings[w.target] : null;

    switch (w.kind) {
      case 'cart': {
        if (dest) {
          for (const g of Object.keys(w.cargo) as GoodId[]) {
            dest.store[g] = (dest.store[g] ?? 0) + (w.cargo[g] ?? 0);
          }
        }
        this.kill(w.id);
        return;
      }
      case 'supply': {
        if (dest) {
          for (const g of Object.keys(w.cargo) as GoodId[]) {
            dest.store[g] = (dest.store[g] ?? 0) + (w.cargo[g] ?? 0);
          }
        }
        this.kill(w.id);
        return;
      }
      case 'buyer': {
        const home = w.home >= 0 ? city.buildings[w.home] : null;
        if (!w.returning) {
          // At the store: load up and head home.
          if (dest && home) {
            let space = 120;
            for (const g of [...FOOD_IDS, ...HOUSEHOLD_GOODS]) {
              if (space <= 0) break;
              const have = dest.store[g] ?? 0;
              if (have < 1) continue;
              const take = Math.min(have, space, 45);
              dest.store[g] = have - take;
              w.cargo[g] = (w.cargo[g] ?? 0) + take;
              space -= take;
            }
          }
          w.returning = true;
          if (home) {
            const path = this.pathToBuilding(w.tile, home);
            if (path) {
              w.path = path;
              w.pathIdx = 0;
              w.target = home.id;
              return;
            }
          }
          this.kill(w.id);
          return;
        }
        // Home again: unload into the bazaar.
        if (home) {
          for (const g of Object.keys(w.cargo) as GoodId[]) {
            home.store[g] = (home.store[g] ?? 0) + (w.cargo[g] ?? 0);
          }
        }
        this.kill(w.id);
        return;
      }
      case 'laborer': {
        if (dest?.monument) dest.monument.laborDone += 12;
        this.kill(w.id);
        return;
      }
      case 'immigrant': {
        if (dest?.house) {
          dest.house.people += w.people;
          city.population += w.people;
          if (dest.house.level === 0) dest.house.level = 1;
        }
        this.kill(w.id);
        return;
      }
      case 'trader': {
        if (dest) {
          for (const g of Object.keys(w.cargo) as GoodId[]) {
            dest.store[g] = (dest.store[g] ?? 0) + (w.cargo[g] ?? 0);
          }
        }
        this.kill(w.id);
        return;
      }
      case 'emigrant': {
        this.kill(w.id);
        return;
      }
      default:
        this.kill(w.id);
    }
  }

  /** A roamer that has run out of road walks home, or simply vanishes if it cannot. */
  private arriveHomeOrDie(w: Walker): void {
    if (w.kind === 'service' || w.kind === 'seller') {
      const home = w.home >= 0 ? this.city.buildings[w.home] : null;
      if (home && !w.returning) {
        w.returning = true;
        const path = this.pathToBuilding(w.tile, home);
        if (path && path.length > 1) {
          w.path = path;
          w.pathIdx = 0;
          w.target = home.id;
          w.kind = w.kind === 'seller' ? 'seller' : 'service';
          // While walking home the seller keeps selling, which is authentic and useful.
          return;
        }
      }
      // A seller that gets home returns unsold stock to the bazaar.
      if (home && w.kind === 'seller') {
        for (const g of Object.keys(w.cargo) as GoodId[]) {
          home.store[g] = (home.store[g] ?? 0) + (w.cargo[g] ?? 0);
        }
      }
    }
    this.kill(w.id);
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  /** Enemies march overland toward the nearest thing worth destroying. */
  private stepEnemy(w: Walker): void {
    const city = this.city;
    const world = city.world;
    // Head for the highest-value nearby building; failing that, the map centre.
    let tx = world.size >> 1;
    let ty = world.size >> 1;
    let best = -Infinity;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b) continue;
      const def = city.def(b);
      const value = (b.house ? b.house.people * 2 : def.cost * 0.05) -
        (Math.abs(b.x - w.px) + Math.abs(b.y - w.py)) * 0.6;
      if (value > best) {
        best = value;
        tx = b.x;
        ty = b.y;
      }
    }
    // Enemies ignore roads entirely; they walk straight over the desert.
    const dx = Math.sign(tx + 0.5 - w.px);
    const dy = Math.sign(ty + 0.5 - w.py);
    const nx = clamp(world.xOf(w.tile) + (Math.abs(tx + 0.5 - w.px) > Math.abs(ty + 0.5 - w.py) ? dx : 0), 0, world.size - 1);
    const ny = clamp(world.yOf(w.tile) + (Math.abs(tx + 0.5 - w.px) > Math.abs(ty + 0.5 - w.py) ? 0 : dy), 0, world.size - 1);
    const next = world.idx(nx, ny);
    w.nextTile = world.terrain[next] === 0 /* water */ ? w.tile : next;
  }

  private enemyAttackAdjacent(w: Walker): void {
    const city = this.city;
    const world = city.world;
    const x = world.xOf(w.tile);
    const y = world.yOf(w.tile);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (!world.inBounds(px, py)) continue;
        const id = world.building[world.idx(px, py)];
        if (id < 0) continue;
        const b = city.buildings[id];
        if (!b) continue;
        b.damage = Math.min(140, b.damage + 18);
        if (b.damage >= 130) {
          city.pushMessage('Buildings destroyed', `Raiders have levelled part of your city.`, 'bad', w.tile);
          city.demolish(b.x, b.y);
          return;
        }
      }
    }
  }

  /** Total live walkers, for the HUD and for perf budgeting. */
  get count(): number {
    return this.live.length;
  }
}
