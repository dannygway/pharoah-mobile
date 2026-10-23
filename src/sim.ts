/**
 * The city simulation.
 *
 * Everything runs on a fixed tick. `TICKS_PER_MONTH` ticks make a month, twelve months
 * make a year, and the year is divided into the three Egyptian seasons. The renderer
 * never advances the simulation; it only interpolates between the last two states.
 */

import { RNG, clamp, approach } from './core';
import {
  BUILDING_BY_ID, BuildingDef, GOODS, GoodId, FOOD_IDS, HOUSEHOLD_GOODS, HOUSING,
  ServiceId, GodId, GOD_IDS, GODS, RELIGION_SERVICE, LaborSector, seasonOfMonth, Season, MONTHS, houseMinSize,
} from './data';
import { World, Terrain } from './world';
import { TICKS_PER_MONTH, TICKS_PER_YEAR, TICKS_PER_DAY, SERVICE_DURATION as SVC_TICKS } from './consts';
import { Walker, WalkerSystem } from './walkers';

export { TICKS_PER_MONTH, TICKS_PER_YEAR, SERVICE_DURATION } from './consts';

export interface HouseState {
  level: number;
  people: number;
  /** Food units held, by type. */
  foods: Partial<Record<GoodId, number>>;
  goods: Partial<Record<GoodId, number>>;
  /** Ticks of freshness remaining, per service. */
  services: Partial<Record<ServiceId, number>>;
  health: number;
  /** Consecutive months this household has gone short of food. */
  hunger: number;
  /** Ticks since a tax collector called. */
  taxFresh: number;
  crime: number;
  /** Cached evolution result for the UI: what is blocking the next level. */
  blocker: string;
}

export interface MonumentState {
  stage: number;
  laborDone: number;
  delivered: Partial<Record<GoodId, number>>;
  complete: boolean;
}

export interface GarrisonState {
  strength: number;
  maxStrength: number;
  morale: number;
  training: number;
  /** Tile the company is ordered to hold, or -1 to stay at the fort. */
  orderTile: number;
  x: number;
  y: number;
}

export interface Building {
  id: number;
  defId: string;
  x: number;
  y: number;
  size: number;
  /** Construction progress 0..1; below 1 the building is a site. */
  built: number;
  /** Workers currently assigned. */
  workers: number;
  /** 0..1 — how much of the desired workforce is present. */
  staffing: number;
  /** Ticks accumulated toward the current production cycle. */
  progress: number;
  store: Partial<Record<GoodId, number>>;
  fire: number;
  damage: number;
  walkerCooldown: number;
  /** Live walker ids spawned by this building. */
  walkers: number[];
  hasRoad: boolean;
  /** Set false while the player has mothballed the building. */
  enabled: boolean;
  house?: HouseState;
  monument?: MonumentState;
  garrison?: GarrisonState;
  /**
   * Storage yard / granary per-good policy.
   *  accept — carts may deposit here
   *  refuse — carts may not; existing stock is carried away
   *  get    — this store actively sends carts to fetch the good from other stores
   *  empty  — stock is removed and nothing new is accepted
   * Setting a farm-side granary to accept and a housing-side granary to get is the
   * foundational technique for moving food across a city without long bazaar trips.
   */
  orders?: Partial<Record<GoodId, 'accept' | 'refuse' | 'get' | 'empty'>>;
  /** Entertainment venues hold a performer sent from their school; 0 means idle. */
  performers?: number;
  /** Floodplain farm: worked by work-camp peasants rather than by the city's labour. */
  campFarm?: boolean;
  /** Ticks of peasant labour left on a floodplain farm. It grows only while this is > 0. */
  tended?: number;
  /** Cosmetic seed so identical buildings do not look identical. */
  variant: number;
  /** Ticks the building has been standing, for gentle art variation. */
  age: number;
}

export interface CityMessage {
  id: number;
  tick: number;
  title: string;
  body: string;
  kind: 'info' | 'warn' | 'bad' | 'good' | 'request';
  /** Tile to jump the camera to, if relevant. */
  tile?: number;
  read: boolean;
}

export interface TradeRoute {
  city: string;
  kind: 'land' | 'sea';
  open: boolean;
  cost: number;
  /** Goods this city will sell you, with an annual quota. */
  sells: Partial<Record<GoodId, number>>;
  /** Goods this city will buy from you, with an annual quota. */
  buys: Partial<Record<GoodId, number>>;
  /** Remaining quota this year. */
  soldThisYear: Partial<Record<GoodId, number>>;
  boughtThisYear: Partial<Record<GoodId, number>>;
}

export interface PharaohRequest {
  id: number;
  good: GoodId | 'troops' | 'deben';
  amount: number;
  dueTick: number;
  delivered: number;
  /** Kingdom rating change on success / failure. */
  reward: number;
  penalty: number;
  resolved: 'pending' | 'met' | 'failed';
}

export interface Invasion {
  id: number;
  enemy: string;
  strength: number;
  arrivalTick: number;
  warned: boolean;
  landed: boolean;
  /** Edge tile the enemy enters from. */
  entryTile: number;
}

export type LaborPriority = LaborSector[];

/**
 * Who gets workers first when there are not enough to go round.
 *
 * Safety — the firehouse and the architect's post — sits second, above everything but
 * food. It used to be lumped in with government, ninth of twelve, which meant that in
 * any city short of labour the two services whose failure is *permanent* were the two
 * that never got staffed: a district would burn to the ground while its bazaar and its
 * temple ran at full strength. A player can still demote it; the default should not
 * quietly guarantee the loss.
 */
export const DEFAULT_LABOR_PRIORITY: LaborPriority = [
  'food', 'safety', 'distribution', 'industry', 'infrastructure', 'health', 'religion',
  'education', 'culture', 'government', 'monument', 'military', 'trade',
];

export interface Ratings {
  culture: number;
  prosperity: number;
  monument: number;
  kingdom: number;
}

export class City {
  world: World;
  rng: RNG;
  walkers: WalkerSystem;

  buildings: (Building | null)[] = [];
  private freeBuildingIds: number[] = [];
  /** Buildings that need a per-month visit, kept as a dense list for iteration. */
  liveBuildings: number[] = [];

  tick = 0;
  funds = 2000;
  /** Player's personal savings, drawn from salary. */
  savings = 0;
  salary = 60;
  taxRate = 0.08;
  /** Wage rate as a multiple of the kingdom standard. 1.0 is neutral. */
  wageRate = 1.0;

  /** City mood, 0..100, with the dominant cause named for the player. */
  sentiment = 60;
  sentimentCause = 'Your city is settled';

  population = 0;
  /** Residents of manors and estates: they pay well and do not work. */
  scribes = 0;
  workforce = 0;
  employed = 0;
  unemployment = 0;
  laborPriority: LaborPriority = [...DEFAULT_LABOR_PRIORITY];

  /** God mood, -100..100. */
  godMood: Record<GodId, number> = { osiris: 20, ra: 20, ptah: 20, seth: 20, bast: 20 };
  /** Months since each god's last festival. */
  godFestival: Record<GodId, number> = { osiris: 0, ra: 0, ptah: 0, seth: 0, bast: 0 };
  /** Consecutive months a god has spent furious. Wrath needs persistence, not one bad roll. */
  godAnger: Record<GodId, number> = { osiris: 0, ra: 0, ptah: 0, seth: 0, bast: 0 };
  /** Months before a god who has already struck may strike again. */
  godWrathCooldown: Record<GodId, number> = { osiris: 0, ra: 0, ptah: 0, seth: 0, bast: 0 };
  /** How many times Seth has acted. His answer escalates; it does not open with an army. */
  sethStrikes = 0;

  ratings: Ratings = { culture: 0, prosperity: 0, monument: 0, kingdom: 50 };

  /** Flood cycle state. */
  floodLevel = 0;
  floodQuality = 0.6;
  nextFloodQuality = 0.6;

  messages: CityMessage[] = [];
  private nextMessageId = 1;

  trade: TradeRoute[] = [];
  requests: PharaohRequest[] = [];
  private nextRequestId = 1;
  invasions: Invasion[] = [];
  private nextInvasionId = 1;

  /** Entry point road tile where immigrants and caravans appear. */
  entryTile = -1;
  exitTile = -1;

  /** Aggregate counters refreshed each month, for advisors and the HUD. */
  stats = {
    housed: 0,
    capacity: 0,
    foodStored: 0,
    foodProducedPerMonth: 0,
    foodConsumedPerMonth: 0,
    unemployed: 0,
    workersNeeded: 0,
    avgHealth: 100,
    crime: 0,
    fireRisk: 0,
    damageRisk: 0,
    literacy: 0,
    monthlyIncome: 0,
    monthlyExpense: 0,
    immigrationRate: 0,
  };

  private desirabilityDirty = true;
  private monthAccumulator = 0;
  private dayAccumulator = 0;

  /** Cache of building ids by def, for cheap "do I have one of these" checks. */
  private countsByDef = new Map<string, number>();

  constructor(world: World, seed = 1) {
    this.world = world;
    this.rng = new RNG(seed);
    this.walkers = new WalkerSystem(this);
    this.findEntryPoints();
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------

  get year(): number {
    return Math.floor(this.tick / TICKS_PER_YEAR);
  }
  get month(): number {
    return Math.floor((this.tick % TICKS_PER_YEAR) / TICKS_PER_MONTH);
  }
  get monthName(): string {
    return MONTHS[this.month];
  }
  get season(): Season {
    return seasonOfMonth(this.month);
  }
  /** 0..1 progress through the current month. */
  get monthFraction(): number {
    return (this.tick % TICKS_PER_MONTH) / TICKS_PER_MONTH;
  }

  // -------------------------------------------------------------------------
  // Building lifecycle
  // -------------------------------------------------------------------------

  def(b: Building): BuildingDef {
    return BUILDING_BY_ID[b.defId];
  }

  /**
   * A farm on the black land is worked by peasants walking out from a work camp, as in
   * Pharaoh, not by the city's own labour pool. The same farm laid out on the meadow
   * hires its own hands instead.
   */
  isCampFarm(def: BuildingDef, x: number, y: number): boolean {
    if (!def.campWorked) return false;
    let fp = 0;
    for (let dy = 0; dy < def.size; dy++) {
      for (let dx = 0; dx < def.size; dx++) {
        if (this.world.inBounds(x + dx, y + dy) && this.world.terrain[this.world.idx(x + dx, y + dy)] === Terrain.Floodplain) fp++;
      }
    }
    return fp * 2 > def.size * def.size;
  }

  /** People a house can hold: its level's capacity, scaled by any extra footprint. */
  houseCapacity(b: Building): number {
    const lvl = Math.max(1, b.house?.level ?? 1);
    const min = houseMinSize(lvl);
    return Math.round(HOUSING[lvl].capacity * (b.size * b.size) / (min * min));
  }

  /** A house's desirability is the mean across its whole plot, not its corner tile. */
  houseDesirability(b: Building): number {
    const w = this.world;
    let sum = 0;
    for (let dy = 0; dy < b.size; dy++) {
      for (let dx = 0; dx < b.size; dx++) sum += w.desirability[w.idx(b.x + dx, b.y + dy)];
    }
    return Math.round(sum / (b.size * b.size));
  }

  /**
   * Grow a house to an m×m plot by absorbing the housing around it.
   *
   * Every tile of the new plot must already be housing — vacant lots or homes no
   * grander than this one — lying wholly inside the square. Roads, gardens, wells and
   * any other building all block it. The absorbed households move in, up to the new
   * home's capacity. Returns false if no such square exists around this house.
   */
  private tryGrowHouse(b: Building, m: number): boolean {
    const w = this.world;
    const h = b.house!;
    for (let oy = b.y + b.size - m; oy <= b.y; oy++) {
      for (let ox = b.x + b.size - m; ox <= b.x; ox++) {
        if (!w.inBounds(ox, oy) || !w.inBounds(ox + m - 1, oy + m - 1)) continue;
        const absorbed = new Set<number>();
        let ok = true;
        for (let dy = 0; dy < m && ok; dy++) {
          for (let dx = 0; dx < m && ok; dx++) {
            const id = w.building[w.idx(ox + dx, oy + dy)];
            const o = id >= 0 ? this.buildings[id] : null;
            if (!o?.house) { ok = false; break; }
            if (o.x < ox || o.y < oy || o.x + o.size > ox + m || o.y + o.size > oy + m) { ok = false; break; }
            if (o !== b && o.house.level > h.level) { ok = false; break; }
            if (o !== b) absorbed.add(id);
          }
        }
        if (!ok) continue;

        let people = h.people;
        let healthSum = h.health * Math.max(1, h.people);
        let weight = Math.max(1, h.people);
        for (const id of absorbed) {
          const o = this.buildings[id]!;
          const oh = o.house!;
          people += oh.people;
          healthSum += oh.health * Math.max(1, oh.people);
          weight += Math.max(1, oh.people);
          for (const [g, v] of Object.entries(oh.foods)) h.foods[g as GoodId] = (h.foods[g as GoodId] ?? 0) + (v ?? 0);
          for (const [g, v] of Object.entries(oh.goods)) h.goods[g as GoodId] = (h.goods[g as GoodId] ?? 0) + (v ?? 0);
          for (const [k, v] of Object.entries(oh.services)) {
            h.services[k as ServiceId] = Math.max(h.services[k as ServiceId] ?? 0, v ?? 0);
          }
          h.taxFresh = Math.max(h.taxFresh, oh.taxFresh);
          for (const wid of o.walkers) this.walkers.kill(wid);
          this.buildings[id] = null;
          this.freeBuildingIds.push(id);
          const li = this.liveBuildings.indexOf(id);
          if (li >= 0) this.liveBuildings.splice(li, 1);
          this.countsByDef.set('house', Math.max(0, this.countOf('house') - 1));
        }
        b.x = ox;
        b.y = oy;
        b.size = m;
        for (let dy = 0; dy < m; dy++) {
          for (let dx = 0; dx < m; dx++) w.building[w.idx(ox + dx, oy + dy)] = b.id;
        }
        h.health = healthSum / weight;
        const cap = this.houseCapacity(b);
        if (people > cap) {
          // Those who cannot fit find somewhere else, or leave.
          this.population -= people - cap;
          people = cap;
        }
        h.people = people;
        this.refreshRoadAccess(b);
        this.desirabilityDirty = true;
        return true;
      }
    }
    return false;
  }

  /** How many of the city's workers this building wants. */
  workersFor(b: Building): number {
    return b.campFarm ? 0 : this.def(b).workers;
  }

  countOf(defId: string): number {
    return this.countsByDef.get(defId) ?? 0;
  }

  /** Place a building. Returns the new id, or -1 if it could not be placed. */
  place(defId: string, x: number, y: number, free = false): number {
    const def = BUILDING_BY_ID[defId];
    if (!def) return -1;

    if (defId === 'road' || defId === 'plaza') return this.placeRoad(x, y, defId, free);

    const allowRock = def.terrain === 'rock';
    if (!this.world.canPlace(x, y, def.size, def.terrain, allowRock)) return -1;
    if (!free && this.funds < def.cost) return -1;
    if (!free) this.funds -= def.cost;

    const id = this.allocBuilding();
    const b: Building = {
      id, defId, x, y, size: def.size,
      built: def.cat === 'monument' ? 0 : 1,
      workers: 0, staffing: 0, progress: 0, store: {},
      fire: 0, damage: 0, walkerCooldown: this.rng.int(def.walkerInterval ?? 120),
      walkers: [], hasRoad: false, enabled: true,
      variant: this.rng.int(1000), age: 0,
    };

    if (def.cat === 'housing') {
      b.house = {
        level: 0, people: 0, foods: {}, goods: {}, services: {},
        health: 100, hunger: 0, taxFresh: 0, crime: 0, blocker: 'Waiting for settlers',
      };
    }
    if (def.monument) {
      b.monument = { stage: 0, laborDone: 0, delivered: {}, complete: false };
      b.built = 0;
    }
    if (def.garrison) {
      b.garrison = {
        strength: 0, maxStrength: def.garrison, morale: 100, training: 0,
        orderTile: -1, x: x + def.size / 2, y: y + def.size / 2,
      };
    }
    if (def.storage) {
      b.orders = {};
    }
    b.campFarm = this.isCampFarm(def, x, y);

    this.buildings[id] = b;
    this.liveBuildings.push(id);
    this.countsByDef.set(defId, this.countOf(defId) + 1);

    for (let dy = 0; dy < def.size; dy++) {
      for (let dx = 0; dx < def.size; dx++) {
        this.world.building[this.world.idx(x + dx, y + dy)] = id;
      }
    }
    this.desirabilityDirty = true;
    this.refreshRoadAccess(b);
    return id;
  }

  private placeRoad(x: number, y: number, defId: string, free: boolean): number {
    const w = this.world;
    if (!w.inBounds(x, y)) return -1;
    const i = w.idx(x, y);
    if (w.terrain[i] === Terrain.Water || w.terrain[i] === Terrain.Rock) return -1;
    if (w.building[i] !== -1) return -1;
    const def = BUILDING_BY_ID[defId];
    const already = w.road[i] === 1;
    // Upgrading dirt to plaza is allowed and costs the difference.
    if (already && defId === 'road') return -1;
    const cost = def.cost;
    if (!free && this.funds < cost) return -1;
    if (!free) this.funds -= cost;
    w.road[i] = 1;
    w.groundVersion++;
    // Plazas are recorded as a building so their desirability is tracked, but they
    // remain walkable road tiles.
    if (defId === 'plaza') {
      const id = this.allocBuilding();
      this.buildings[id] = {
        id, defId, x, y, size: 1, built: 1, workers: 0, staffing: 1, progress: 0,
        store: {}, fire: 0, damage: 0, walkerCooldown: 0, walkers: [], hasRoad: true,
        enabled: true, variant: this.rng.int(1000), age: 0,
      };
      this.liveBuildings.push(id);
      this.countsByDef.set(defId, this.countOf(defId) + 1);
      this.desirabilityDirty = true;
      return id;
    }
    this.desirabilityDirty = true;
    this.markRoadNeighboursDirty(x, y);
    return -2; // roads have no building id
  }

  private markRoadNeighboursDirty(x: number, y: number): void {
    // Buildings within a couple of tiles may have just gained road access.
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (!this.world.inBounds(px, py)) continue;
        const id = this.world.building[this.world.idx(px, py)];
        if (id >= 0 && this.buildings[id]) this.refreshRoadAccess(this.buildings[id]!);
      }
    }
  }

  private allocBuilding(): number {
    const reused = this.freeBuildingIds.pop();
    if (reused !== undefined) return reused;
    this.buildings.push(null);
    return this.buildings.length - 1;
  }

  refreshRoadAccess(b: Building): void {
    b.hasRoad = this.world.touchesRoad(b.x, b.y, b.size);
  }

  /** Demolish whatever occupies (x,y): a building, or a road tile. */
  demolish(x: number, y: number, refund = false): boolean {
    const w = this.world;
    if (!w.inBounds(x, y)) return false;
    const i = w.idx(x, y);
    const id = w.building[i];
    if (id >= 0) {
      const b = this.buildings[id];
      if (!b) return false;
      const def = this.def(b);
      // Plaza tiles double as roads.
      if (def.id === 'plaza') {
        w.road[i] = 0;
        w.groundVersion++;
      }
      for (let dy = 0; dy < b.size; dy++) {
        for (let dx = 0; dx < b.size; dx++) {
          const j = w.idx(b.x + dx, b.y + dy);
          if (w.building[j] === id) w.building[j] = -1;
        }
      }
      for (const wid of b.walkers) this.walkers.kill(wid);
      if (b.house) this.population -= b.house.people;
      this.buildings[id] = null;
      this.freeBuildingIds.push(id);
      const li = this.liveBuildings.indexOf(id);
      if (li >= 0) this.liveBuildings.splice(li, 1);
      this.countsByDef.set(def.id, Math.max(0, this.countOf(def.id) - 1));
      if (refund) this.funds += Math.floor(def.cost * 0.25);
      else this.funds -= Math.max(1, Math.floor(def.cost * 0.02));
      this.desirabilityDirty = true;
      return true;
    }
    if (w.road[i]) {
      w.road[i] = 0;
      w.groundVersion++;
      this.funds -= 1;
      this.desirabilityDirty = true;
      this.markRoadNeighboursDirty(x, y);
      return true;
    }
    return false;
  }

  buildingAt(x: number, y: number): Building | null {
    if (!this.world.inBounds(x, y)) return null;
    const id = this.world.building[this.world.idx(x, y)];
    return id >= 0 ? this.buildings[id] : null;
  }

  // -------------------------------------------------------------------------
  // Main tick
  // -------------------------------------------------------------------------

  step(): void {
    this.tick++;
    this.walkers.step();

    // Production and walker despatch run every tick so the city feels continuously busy.
    for (let k = 0; k < this.liveBuildings.length; k++) {
      const b = this.buildings[this.liveBuildings[k]];
      if (b) this.stepBuilding(b);
    }

    if (++this.dayAccumulator >= TICKS_PER_DAY) {
      this.dayAccumulator = 0;
      this.stepDay();
    }
    if (++this.monthAccumulator >= TICKS_PER_MONTH) {
      this.monthAccumulator = 0;
      this.monthPhase = 0;
    }
    if (this.monthPhase >= 0) this.stepMonthPhase();
    this.stepFlood();
  }

  private stepBuilding(b: Building): void {
    const def = this.def(b);
    b.age++;

    if (b.monument && !b.monument.complete) {
      // Monument progress is driven by guild deliveries, handled in systems.ts.
      return;
    }

    if (!b.enabled || !b.built) return;
    if (b.campFarm && (b.tended ?? 0) > 0) b.tended!--;

    // A building with no road link cannot despatch anyone or receive deliveries.
    const operational = b.campFarm ? (b.tended ?? 0) > 0 : b.staffing > 0 || def.workers === 0;

    // Production.
    if (def.produces && operational) {
      const rate = this.productionRate(b, def);
      if (rate > 0) {
        b.progress += rate;
        const need = def.cycleTicks ?? 600;
        if (b.progress >= need) {
          if (this.consumeInputs(b, def)) {
            b.progress -= need;
            const qty = def.produceQty ?? 1;
            b.store[def.produces] = (b.store[def.produces] ?? 0) + qty;
            for (const [g, q] of Object.entries(def.alsoProduces ?? {})) {
              b.store[g as GoodId] = (b.store[g as GoodId] ?? 0) + (q as number);
            }
          } else {
            b.progress = need; // stall at full, waiting for materials
          }
        }
      }
    }

    // Libraries consume papyrus without producing anything.
    if (!def.produces && def.consumes && def.cycleTicks && operational) {
      b.progress += b.staffing;
      if (b.progress >= def.cycleTicks) {
        b.progress = 0;
        this.consumeInputs(b, def);
      }
    }

    // A venue with no performer sends nobody out. The school, not the venue, is the
    // thing that was missing.
    if (def.needsPerformerFrom) {
      b.performers = Math.max(0, (b.performers ?? 0) - 0.006);
      if ((b.performers ?? 0) <= 0) return;
    }

    // Walker despatch.
    if (def.walkerInterval && b.hasRoad && operational) {
      if (b.walkerCooldown > 0) b.walkerCooldown--;
      else if (b.walkers.length < this.maxWalkersFor(def)) {
        if (this.walkers.spawnFrom(b, def)) {
          // A fully staffed building sends its next walker soon after the last one
          // sets out, as Pharaoh's do: patrols are near-continuous, streets are busy,
          // and coverage holds steady instead of flickering in and out.
          b.walkerCooldown = Math.max(30, Math.round((def.walkerInterval ?? 240) * 0.5 / Math.max(0.35, b.staffing)));
        } else {
          b.walkerCooldown = 60;
        }
      }
    }

    // Producers push finished goods out to storage via cart pushers — the main output
    // first, then any by-product, so straw does not sit in a grain field forever.
    if (def.produces && b.hasRoad) {
      const outputs: [GoodId, number][] = [[def.produces, def.produceQty ?? 8]];
      for (const [g, q] of Object.entries(def.alsoProduces ?? {})) outputs.push([g as GoodId, q as number]);
      for (const [good, qty] of outputs) {
        const have = b.store[good] ?? 0;
        const batch = Math.max(4, Math.floor(qty / 2));
        if (have >= batch && b.walkers.length < 3) {
          if (this.walkers.spawnCart(b, good, Math.min(have, batch * 2))) {
            b.store[good] = have - Math.min(have, batch * 2);
            break;
          }
        }
      }
    }

    // Bazaars fetch stock when low.
    if (def.id === 'bazaar' && b.hasRoad && operational) {
      // Restock while there is still stock to sell, not once the shelves are bare: a
      // buyer's round trip takes longer than a seller's, so waiting until the bazaar
      // is nearly empty guarantees a gap with nothing on the street.
      const total = Object.values(b.store).reduce((a: number, v) => a + (v ?? 0), 0);
      if (total < 220 && b.walkers.length < 4) this.walkers.spawnBuyer(b);
    }
  }

  private maxWalkersFor(def: BuildingDef): number {
    if (def.id === 'bazaar') return 5;
    if (def.cat === 'religion') return 3;
    return 3;
  }

  /** Ticks of progress this building earns this tick. */
  private productionRate(b: Building, def: BuildingDef): number {
    let rate = b.staffing;
    if (b.campFarm) {
      // The black land follows the Nile: nothing grows under water, and nothing grows
      // at all unless peasants have come out from a camp to work it.
      const i = this.world.idx(b.x + (b.size >> 1), b.y + (b.size >> 1));
      if (this.world.flooded[i]) return 0;
      if ((b.tended ?? 0) <= 0) return 0;
      const season = this.season;
      const seasonMul = season === 'akhet' ? 0.15 : season === 'peret' ? 1.0 : 1.45;
      const fert = this.averageFertility(b);
      rate = seasonMul * (0.45 + (fert / 100) * 1.05);
    } else if (def.campWorked) {
      // A meadow farm: its own staff, no flood to stop it, and no silt to feed it.
      rate *= 0.62;
    }
    // Damage and fire slow a building down before they destroy it.
    rate *= 1 - clamp(b.damage / 200, 0, 0.5);
    return rate;
  }

  private averageFertility(b: Building): number {
    let sum = 0;
    let n = 0;
    for (let dy = 0; dy < b.size; dy++) {
      for (let dx = 0; dx < b.size; dx++) {
        const i = this.world.idx(b.x + dx, b.y + dy);
        sum += this.world.fertility[i];
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  private consumeInputs(b: Building, def: BuildingDef): boolean {
    if (!def.consumes) return true;
    for (const [g, qty] of Object.entries(def.consumes)) {
      if ((b.store[g as GoodId] ?? 0) < (qty as number)) return false;
    }
    for (const [g, qty] of Object.entries(def.consumes)) {
      b.store[g as GoodId] = (b.store[g as GoodId] ?? 0) - (qty as number);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Daily pass
  // -------------------------------------------------------------------------

  private stepDay(): void {
    if (this.desirabilityDirty) {
      this.recomputeDesirability();
      this.desirabilityDirty = false;
    }
    this.applyDirectServices();
    this.decayServices();
    this.accumulateRisk();
    this.farmDrawdown();
  }

  /**
   * Some buildings serve a radius rather than a route. A well is the obvious case:
   * nobody carries the water, the neighbours simply come and draw it.
   */
  private applyDirectServices(): void {
    const w = this.world;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b || !b.built || !b.enabled) continue;
      const def = this.def(b);
      if (!def.directRange || !def.service) continue;
      if (def.workers > 0 && b.staffing <= 0) continue;
      const r = def.directRange;
      for (let dy = -r; dy < r + b.size; dy++) {
        for (let dx = -r; dx < r + b.size; dx++) {
          const px = b.x + dx;
          const py = b.y + dy;
          if (!w.inBounds(px, py)) continue;
          const nid = w.building[w.idx(px, py)];
          if (nid < 0) continue;
          const nb = this.buildings[nid];
          if (!nb?.house) continue;
          nb.house.services[def.service] = SVC_TICKS;
        }
      }
    }
  }

  /** Service freshness ticks down; a house whose priest stops calling slides back. */
  private decayServices(): void {
    const dec = 30;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house) continue;
      const s = b.house.services;
      for (const k of Object.keys(s) as ServiceId[]) {
        const v = (s[k] ?? 0) - dec;
        if (v <= 0) delete s[k];
        else s[k] = v;
      }
      b.house.taxFresh = Math.max(0, b.house.taxFresh - dec);
    }
  }

  private accumulateRisk(): void {
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b || !b.built) continue;
      const def = this.def(b);
      const fireBase = def.fireRisk ?? (b.house ? 0.3 + b.house.level * 0.02 : 0.15);
      const dmgBase = def.damageRisk ?? (b.house ? 0.25 : 0.2);
      // Ra's displeasure makes the city burn.
      const raMul = this.godMood.ra < -40 ? 2.2 : 1;
      // Slow enough that a young city gets a chance. At the previous rate a bazaar
      // went from built to burnt inside ten months, which meant the first fire always
      // arrived before the player had the workers to staff a firehouse — punishment
      // for the opening, not a hazard to manage.
      b.fire = clamp(b.fire + fireBase * raMul * 0.26, 0, 120);
      b.damage = clamp(b.damage + dmgBase * 0.24, 0, 120);
    }
  }

  /** Growing crops draw fertility out of the soil; only the flood puts it back. */
  private farmDrawdown(): void {
    this.world.groundVersion++;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b) continue;
      const def = this.def(b);
      if (!b.campFarm) continue;
      if (b.staffing <= 0) continue;
      for (let dy = 0; dy < b.size; dy++) {
        for (let dx = 0; dx < b.size; dx++) {
          const i = this.world.idx(b.x + dx, b.y + dy);
          if (this.world.flooded[i]) continue;
          this.world.fertility[i] = Math.max(0, this.world.fertility[i] - 0.45);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Monthly pass
  // -------------------------------------------------------------------------

  /**
   * The monthly pass, spread over the first six ticks of the month.
   *
   * Every part is cheap, but run together on one tick they made one long frame — in a
   * big city about ten milliseconds, which at speed and 120 Hz is a visible hitch every
   * couple of seconds. Same work, same order, no single heavy frame.
   */
  private monthPhase = -1;
  private stepMonthPhase(): void {
    switch (this.monthPhase++) {
      case 0: this.allocateLabor(); this.consumeHousehold(); break;
      case 1: this.evolveHousing(); break;
      case 2: this.collectTaxes(); this.payWages(); break;
      case 3: this.updateImmigration(); break;
      case 4: this.updateHealth(); break;
      default:
        this.updateStats();
        this.updateSentiment();
        this.checkLogistics();
        this.monthPhase = -1;
    }
  }

  /** The whole monthly pass at once, for tests and tools that want it synchronously. */
  stepMonth(): void {
    this.monthPhase = 0;
    while (this.monthPhase >= 0) this.stepMonthPhase();
  }

  /**
   * City mood as a single 0..100 value. The number matters less than the reason: a
   * player told "your people are hungry" can act, a player told "sentiment 43" cannot,
   * so the dominant negative factor is recorded alongside the score.
   */
  private updateSentiment(): void {
    const factors: { delta: number; cause: string }[] = [];

    const foodMonths = this.foodMonthsRemaining();
    if (foodMonths < 0.5) factors.push({ delta: -30, cause: 'Your people are going hungry' });
    else if (foodMonths < 1.5) factors.push({ delta: -10, cause: 'Food is running short' });
    else factors.push({ delta: +8, cause: '' });

    const foodTypes = this.averageFoodVariety();
    if (foodTypes >= 2) factors.push({ delta: +5, cause: '' });

    if (this.unemployment > 0.25) factors.push({ delta: -18, cause: 'Too many people have no work' });
    else if (this.unemployment > 0.12) factors.push({ delta: -7, cause: 'Work is hard to come by' });
    else factors.push({ delta: +6, cause: '' });

    const wageDelta = (this.wageRate - 1) * 24;
    factors.push({ delta: wageDelta, cause: wageDelta < -4 ? 'Wages are below what the kingdom pays' : '' });

    const taxPenalty = (this.taxRate - 0.08) * 260;
    factors.push({ delta: -taxPenalty, cause: taxPenalty > 6 ? 'Taxes are resented' : '' });

    if (this.stats.avgHealth < 45) factors.push({ delta: -14, cause: 'Sickness is spreading' });

    const angriest = GOD_IDS.reduce((a, g) => (this.godMood[g] < this.godMood[a] ? g : a), GOD_IDS[0]);
    if (this.godMood[angriest] < -50) {
      factors.push({ delta: -12, cause: `${GODS[angriest].name} is angry with your city` });
    }

    if (this.stats.crime > 45) factors.push({ delta: -10, cause: 'Crime is troubling the streets' });

    let target = 50;
    for (const f of factors) target += f.delta;
    target = clamp(target, 0, 100);
    this.sentiment = approach(this.sentiment, target, 8);

    const worst = factors
      .filter((f) => f.cause && f.delta < 0)
      .sort((a, b) => a.delta - b.delta)[0];
    this.sentimentCause = worst
      ? worst.cause
      : this.sentiment > 75 ? 'Your people are content'
      : this.sentiment > 50 ? 'Your city is settled'
      : 'Your people are uneasy';
  }

  private averageFoodVariety(): number {
    let total = 0;
    let n = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house || b.house.people <= 0) continue;
      total += FOOD_IDS.filter((f) => (b.house!.foods[f] ?? 0) > 0.05).length;
      n++;
    }
    return n ? total / n : 0;
  }

  /** Sentiment as a band the UI can show next to the number. */
  get sentimentBand(): string {
    const s = this.sentiment;
    return s > 80 ? 'Delighted' : s > 62 ? 'Content' : s > 45 ? 'Settled'
      : s > 28 ? 'Discontented' : 'Angry';
  }

  private lastLogisticsWarning = -99999;

  /**
   * A workshop whose goods cannot reach a store just fills up and stops, with nothing
   * on screen to explain it. Nine times out of ten the cause is a road network split in
   * two — which is invisible unless somebody says so.
   */
  private checkLogistics(): void {
    if (this.tick - this.lastLogisticsWarning < TICKS_PER_YEAR) return;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b || !b.built || !b.enabled) continue;
      const def = this.def(b);
      if (!def.produces) continue;
      const have = b.store[def.produces] ?? 0;
      if (have < (def.produceQty ?? 8)) continue;

      let why = '';
      if (!b.hasRoad) {
        why = 'it has no road access at all';
      } else if (!this.walkers.canReachStorage(b, def.produces)) {
        const kind = GOODS[def.produces].kind === 'food' ? 'granary' : 'storage yard';
        why = `no ${kind} can be reached from it by road — check that your roads actually join up`;
      }
      if (!why) continue;

      this.lastLogisticsWarning = this.tick;
      this.pushMessage(
        `${def.name} cannot deliver`,
        `Your ${def.name.toLowerCase()} is full of ${GOODS[def.produces].name.toLowerCase()} and ` +
        `production has stopped because ${why}.`,
        'warn',
        this.world.idx(b.x, b.y),
      );
      return;
    }
  }

  /**
   * Workers are drawn from the housed population and handed to buildings in the
   * player's chosen sector order. Within a sector, buildings are served in placement
   * order, so an under-supplied city starves its newest workshops first — which is
   * exactly the pressure that makes labour priority a real decision.
   */
  private allocateLabor(): void {
    // Scribes live in manors and estates. They pay a great deal of tax and lift culture
    // and prosperity, but they do not work, so a city that evolves everything to manor
    // level quietly dismantles its own labour force.
    this.workforce = Math.floor(Math.max(0, this.population - this.scribes) * 0.42);
    let pool = this.workforce;
    let needed = 0;

    const bySector = new Map<LaborSector, Building[]>();
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b) continue;
      const def = this.def(b);
      if (b.campFarm) {
        // Its labour comes from the work camps, so it never enters the pool.
        b.workers = 0;
        b.staffing = (b.tended ?? 0) > 0 ? 1 : 0;
        continue;
      }
      if (!def.workers || !def.sector) {
        b.workers = 0;
        b.staffing = def.workers ? 0 : 1;
        continue;
      }
      if (!b.enabled || !b.built || !b.hasRoad) {
        b.workers = 0;
        b.staffing = 0;
        continue;
      }
      needed += def.workers;
      let arr = bySector.get(def.sector);
      if (!arr) bySector.set(def.sector, (arr = []));
      arr.push(b);
    }

    const order = [
      ...this.laborPriority,
      ...[...bySector.keys()].filter((k) => !this.laborPriority.includes(k)),
    ];

    /*
     * Share the workforce the way Pharaoh does: in a shortage every sector gets a
     * share, and the priority order only tilts it — a sector near the top keeps more of
     * its staff than one near the bottom, but nothing is starved outright.
     *
     * The earlier allocator filled sectors strictly in order. In a young town that
     * meant the first two sectors took every worker, the bazaar got none, no food
     * reached anyone, no settlers came, and so no workers ever arrived to fix it: a
     * deadlock the player could only break by knowing to reorder the labour advisor.
     *
     * Water-filling: each sector gets fraction min(1, λ·weight) of what it wants, with
     * λ raised until the pool is spent. Sectors whose share would exceed what they need
     * are filled and leave the calculation; the rest share what remains.
     */
    const sectors = order.filter((k) => bySector.has(k)).map((k, rank) => {
      const arr = bySector.get(k)!;
      let want = 0;
      for (const b of arr) want += this.def(b).workers;
      return { arr, want, weight: 1 / (1 + 0.35 * rank), frac: 0 };
    }).filter((x) => x.want > 0);

    let open = sectors.slice();
    let remaining = pool;
    while (open.length && remaining > 0) {
      const demand = open.reduce((a, x) => a + x.weight * x.want, 0);
      const lambda = remaining / demand;
      const full = open.filter((x) => lambda * x.weight >= 1);
      if (!full.length) {
        for (const x of open) x.frac = lambda * x.weight;
        remaining = 0;
        break;
      }
      for (const x of full) {
        x.frac = 1;
        remaining -= x.want;
      }
      open = open.filter((x) => x.frac < 1);
    }

    pool = this.workforce;
    const short: { b: Building; rem: number }[] = [];
    for (const x of sectors) {
      for (const b of x.arr) {
        const def = this.def(b);
        const exact = x.frac >= 1 ? def.workers : def.workers * x.frac;
        const give = Math.floor(exact);
        b.workers = give;
        pool -= give;
        if (give < def.workers) short.push({ b, rem: exact - give });
      }
    }
    // Rounding each building down strands a worker or two per sector; hand them out to
    // the buildings that were closest to earning one.
    short.sort((a, b) => b.rem - a.rem);
    for (const { b } of short) {
      if (pool <= 0) break;
      b.workers++;
      pool--;
    }
    for (const x of sectors) {
      for (const b of x.arr) {
        const def = this.def(b);
        b.staffing = def.workers ? b.workers / def.workers : 1;
      }
    }
    pool = Math.max(0, pool);

    this.employed = this.workforce - pool;
    this.stats.workersNeeded = needed;
    this.stats.unemployed = pool;
    this.unemployment = this.workforce > 0 ? pool / this.workforce : 0;

    // A silent labour shortage is the single most confusing failure in this genre:
    // buildings simply stop, with nothing on screen to say why. Say it out loud.
    if (needed > this.workforce * 1.15 && this.workforce > 0) {
      if (this.tick - this.lastLaborWarning > TICKS_PER_YEAR) {
        this.lastLaborWarning = this.tick;
        this.pushMessage(
          'Labour shortage',
          `Your city has ${this.workforce} workers but ${needed} jobs. Buildings low in your ` +
          `labour priority are standing half-staffed or empty. Either house more people, ` +
          `mothball what you do not need, or reorder your priorities in the Labour advisor.`,
          'warn',
        );
      }
    }
  }

  private lastLaborWarning = -99999;

  /** Houses eat, wear out pottery and drink beer. */
  private consumeHousehold(): void {
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house) continue;
      const h = b.house;
      if (h.people <= 0) continue;

      const foodNeed = h.people * 0.30;
      let remaining = foodNeed;
      // Eat evenly across available types so variety is preserved as long as possible.
      const avail = FOOD_IDS.filter((f) => (h.foods[f] ?? 0) > 0.01);
      if (avail.length) {
        const per = remaining / avail.length;
        for (const f of avail) {
          const take = Math.min(h.foods[f]!, per);
          h.foods[f] = h.foods[f]! - take;
          remaining -= take;
          if (h.foods[f]! < 0.01) delete h.foods[f];
        }
      }
      // Going short of food is survivable for a while. A household draws on what it
      // has, complains, and only starts to break up after several hungry months —
      // without that grace period a brand-new settlement can never get started, since
      // the first families have to arrive before anyone can work the fields.
      if (remaining > 0.01) {
        h.hunger++;
        h.health = clamp(h.health - 5, 0, 100);
        if (h.hunger > 3) {
          const severity = clamp(remaining / Math.max(1, foodNeed), 0, 1);
          const leaving = Math.max(1, Math.round(h.people * 0.18 * severity));
          const actual = Math.min(h.people, leaving);
          h.people -= actual;
          this.population -= actual;
        }
      } else {
        h.hunger = 0;
      }

      for (const g of HOUSING[h.level].goods) {
        const need = h.people * 0.045;
        const have = h.goods[g] ?? 0;
        h.goods[g] = Math.max(0, have - need);
        if (h.goods[g]! < 0.01) delete h.goods[g];
      }
    }
  }

  /**
   * Evolve or devolve every house by one step. A house rises only when it meets every
   * requirement of the next level; it falls the moment it fails its current one.
   */
  private evolveHousing(): void {
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house) continue;
      const h = b.house;
      const des = this.houseDesirability(b);

      // An unoccupied lot with any desirability at all attracts a first hut.
      if (h.level === 0) {
        h.blocker = h.people > 0 ? 'Settling' : 'Waiting for settlers';
        if (h.people > 0) h.level = 1;
        continue;
      }

      const cur = HOUSING[h.level];
      const curFail = this.housingFailure(b, h, cur, des);
      if (curFail) {
        h.level = Math.max(1, h.level - 1);
        h.blocker = curFail;
        const cap = this.houseCapacity(b);
        if (h.people > cap) {
          const evicted = h.people - cap;
          h.people = cap;
          this.population -= evicted;
        }
        continue;
      }

      if (h.level >= HOUSING.length - 1) {
        h.blocker = 'At the highest level';
        continue;
      }
      const next = HOUSING[h.level + 1];
      const nextFail = this.housingFailure(b, h, next, des);
      if (nextFail) {
        h.blocker = nextFail;
        continue;
      }
      // Ready in every other respect: now it needs the ground to stand on.
      const need = houseMinSize(next.level);
      if (b.size < need) {
        // Take the smallest plot that fits, but accept a larger one: a block of four
        // residences has no 3×3 square that lies wholly around any one of them, and
        // without this the whole block would be stuck at residence for ever.
        let grew = false;
        for (let m = need; m <= 4 && !grew; m++) grew = this.tryGrowHouse(b, m);
        if (grew) {
          h.blocker = 'Expanding';
        } else {
          h.blocker = `No room to expand: a ${next.name.toLowerCase()} needs a ${need}×${need} plot, ` +
            `and the land around this house is not all housing. Roads, gardens and other buildings block it.`;
        }
        continue;
      }
      h.level++;
      h.blocker = '';
    }
  }

  /** Returns a human-readable reason the house fails `lvl`, or '' if it meets it. */
  private housingFailure(b: Building, h: HouseState, lvl: typeof HOUSING[number], des: number): string {
    if (des < lvl.desirability) return `Desirability is ${des} and it needs ${lvl.desirability} — plant gardens, or move the industry away`;
    // There is deliberately no ceiling. An earlier version failed a house's *current*
    // level when its plot was too pleasant for it, and because the current level is
    // checked before the next one, a hut beside a garden could never advance at all.

    if (lvl.water === 1 && !h.services.wellWater && !h.services.water) return 'No water — no well covers it and no water carrier calls';
    if (lvl.water === 2 && !h.services.water) return 'Needs a water supply, a well is not enough';

    const foodTypes = FOOD_IDS.filter((f) => (h.foods[f] ?? 0) > 0.05).length;
    if (foodTypes < lvl.foodTypes) {
      return foodTypes === 0
        ? 'No food has reached this house — no bazaar seller is calling here'
        : `Only ${foodTypes} kind${foodTypes > 1 ? 's' : ''} of food arrives; it wants ${lvl.foodTypes}`;
    }

    const gods = GOD_IDS.filter((g) => h.services[RELIGION_SERVICE[g]]).length;
    if (gods < lvl.gods) {
      return gods === 0
        ? 'No priest has called here — it needs a shrine or temple within walking distance'
        : `${gods} god${gods > 1 ? 's are' : ' is'} worshipped here; it wants ${lvl.gods}`;
    }

    for (const g of lvl.goods) {
      if ((h.goods[g] ?? 0) <= 0.05) {
        return `No ${GOODS[g].name.toLowerCase()} has reached this house`;
      }
    }

    // Entertainment is counted in distinct types, never in venue count: four booths is
    // one type of entertainment, not four.
    const ent: ServiceId[] = ['booth', 'bandstand', 'pavilion', 'senet'];
    const entTypes = ent.filter((e) => h.services[e]).length;
    if (entTypes < lvl.entertainment) {
      return `Needs ${lvl.entertainment} kinds of entertainment, has ${entTypes}`;
    }

    if (lvl.education === 1 && !h.services.school && !h.services.library) {
      return 'Needs a scribal school or a library';
    }
    if (lvl.education === 2 && !(h.services.school && h.services.library)) {
      return 'Needs both a school and a library';
    }

    if (lvl.health >= 1 && !h.services.physician && !h.services.mortuary) {
      return 'Needs a physician or a mortuary';
    }
    if (lvl.health >= 2 && !h.services.dentist) return 'Needs a dentist';
    if (lvl.health >= 3 && !(h.services.physician && h.services.mortuary)) {
      return 'Needs both a physician and a mortuary';
    }

    if (lvl.magistrate && !h.services.magistrate) return 'No magistrate calls here — it needs a courthouse in range';

    return '';
  }

  private collectTaxes(): void {
    let income = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house) continue;
      const h = b.house;
      if (h.taxFresh <= 0) continue;
      income += h.people * HOUSING[h.level].taxPerPerson * (this.taxRate / 0.08);
    }
    income = Math.round(income);
    this.funds += income;
    this.stats.monthlyIncome = income;
    this.savings += Math.round(this.salary / 12);
  }

  private payWages(): void {
    let expense = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b || !b.built) continue;
      const def = this.def(b);
      expense += def.upkeep;
    }
    // Wages scale with the number of people actually working and with the rate the
    // player has set against the kingdom standard.
    expense += Math.round(this.employed * 0.10 * this.wageRate);
    this.funds -= expense;
    this.stats.monthlyExpense = expense;

    if (this.funds < -500) {
      this.pushMessage('The treasury is empty', 'Your city is deep in debt. Pharaoh is displeased, and your officials are unpaid.', 'bad');
      this.ratings.kingdom = clamp(this.ratings.kingdom - 2, 0, 100);
    }
  }

  /**
   * Immigration is a pull, not a push: people come when there is somewhere to live,
   * food to eat, and work to do. High taxes and unemployment turn the flow around.
   */
  private updateImmigration(): void {
    let capacity = 0;
    let housed = 0;
    let bestLots: Building[] = [];
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house) continue;
      const cap = this.houseCapacity(b);
      capacity += cap;
      housed += b.house.people;
      if (b.house.people < cap && b.hasRoad) bestLots.push(b);
    }
    this.stats.capacity = capacity;
    this.stats.housed = housed;

    const room = capacity - housed;
    const foodMonths = this.foodMonthsRemaining();
    let attractiveness = 0;
    attractiveness += clamp(room / 40, 0, 3);

    if (housed < 60) {
      // The first families come for the land, not for a full granary. Judging a
      // brand-new settlement on its food stores would deadlock it permanently.
      attractiveness += 1.0;
    } else {
      // A city that is visibly running out of food should stop attracting people
      // outright, not merely slow down — otherwise it grows straight through the
      // inundation into a famine it created itself.
      attractiveness += foodMonths > 1.5 ? 1.2 : foodMonths > 0.6 ? -0.5 : -4.0;
    }

    attractiveness -= this.unemployment > 0.18 ? 2.0 : 0;
    attractiveness += this.stats.workersNeeded > this.workforce ? 1.0 : 0;
    attractiveness -= (this.taxRate - 0.08) * 22;
    attractiveness += (this.ratings.prosperity - 30) / 60;
    // Sentiment and the wage rate relative to the kingdom standard both pull directly.
    attractiveness += (this.sentiment - 50) / 25;
    attractiveness += (this.wageRate - 1) * 1.5;

    this.stats.immigrationRate = attractiveness;

    if (attractiveness > 0.4 && bestLots.length && this.entryTile >= 0) {
      // Settlers move in next door to other settlers, and choose the pleasant end of
      // town. Picking uniformly at random across every empty lot spreads a small
      // population so thinly across a large plan that no bazaar or priest can ever
      // reach enough of them — a thin sprawl instead of a district.
      const w = this.world;
      bestLots.sort((a, b) => {
        const ao = a.house!.people > 0 ? 1 : 0;
        const bo = b.house!.people > 0 ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return w.desirability[w.idx(b.x, b.y)] - w.desirability[w.idx(a.x, a.y)];
      });
      const frontier = bestLots.slice(0, Math.max(6, Math.ceil(bestLots.length * 0.12)));
      const wave = clamp(Math.round(attractiveness * 1.6), 1, 8);
      for (let i = 0; i < wave; i++) {
        this.walkers.spawnImmigrant(this.rng.pick(frontier));
      }
    } else if (attractiveness < -1.2 && housed > 0) {
      // People drift away. Emigration is deliberately slower than immigration.
      const leaving = clamp(Math.round(-attractiveness), 1, 5);
      for (let i = 0; i < leaving; i++) {
        const occupied = bestLots.length ? bestLots : [];
        const src = occupied.length ? this.rng.pick(occupied) : null;
        if (src?.house && src.house.people > 0) {
          const n = Math.min(src.house.people, 4);
          src.house.people -= n;
          this.population -= n;
          this.walkers.spawnEmigrant(src, n);
        }
      }
    }
  }

  foodMonthsRemaining(): number {
    let food = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b) continue;
      const def = this.def(b);
      if (def.id === 'granary' || def.id === 'bazaar') {
        for (const f of FOOD_IDS) food += b.store[f] ?? 0;
      }
      if (b.house) for (const f of FOOD_IDS) food += b.house.foods[f] ?? 0;
    }
    this.stats.foodStored = Math.round(food);
    const need = Math.max(1, this.population * 0.30);
    return food / need;
  }

  private updateHealth(): void {
    let total = 0;
    let n = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b?.house || b.house.people <= 0) continue;
      const h = b.house;
      let target = 60;
      if (h.services.apothecary) target += 12;
      if (h.services.physician) target += 16;
      if (h.services.dentist) target += 6;
      if (h.services.mortuary) target += 6;
      if (h.services.water) target += 10;
      else if (h.services.wellWater) target += 4;
      else target -= 20;
      const foodTypes = FOOD_IDS.filter((f) => (h.foods[f] ?? 0) > 0.05).length;
      target += foodTypes * 5;
      if (this.godMood.bast > 50) target += 10;
      if (this.godMood.bast < -40) target -= 25;
      // Marshes breed fever.
      const i = this.world.idx(b.x, b.y);
      if (this.nearTerrain(b.x, b.y, Terrain.Marsh, 4)) target -= 14;
      h.health = approach(h.health, clamp(target, 0, 100), 6);
      total += h.health;
      n++;
    }
    this.stats.avgHealth = n ? Math.round(total / n) : 100;
  }

  private nearTerrain(x: number, y: number, t: Terrain, r: number): boolean {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (!this.world.inBounds(px, py)) continue;
        if (this.world.terrain[this.world.idx(px, py)] === t) return true;
      }
    }
    return false;
  }

  private updateStats(): void {
    let pop = 0;
    let scribePop = 0;
    let literate = 0;
    let crime = 0;
    let fire = 0;
    let dmg = 0;
    let houses = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b) continue;
      if (b.house) {
        pop += b.house.people;
        if (HOUSING[b.house.level].scribes) scribePop += b.house.people;
        houses++;
        if (b.house.services.school || b.house.services.library) literate += b.house.people;
        crime += b.house.crime;
      }
      fire = Math.max(fire, b.fire);
      dmg = Math.max(dmg, b.damage);
    }
    this.population = pop;
    this.scribes = scribePop;
    this.stats.literacy = pop ? Math.round((literate / pop) * 100) : 0;
    this.stats.crime = houses ? crime / houses : 0;
    this.stats.fireRisk = fire;
    this.stats.damageRisk = dmg;
  }

  // -------------------------------------------------------------------------
  // Desirability
  // -------------------------------------------------------------------------

  /**
   * Full recompute. Each emitter writes a falling-off value into a square around it;
   * houses then read the value under their own tile. Recomputed at most once a "day",
   * and only when something has actually been built or destroyed.
   */
  recomputeDesirability(): void {
    const w = this.world;
    w.desirability.fill(0);

    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b) continue;
      const def = this.def(b);
      let emit = def.desirability;
      if (b.house) {
        // Houses themselves radiate: a slum drags a district down, an estate lifts it.
        const lv = b.house.level;
        // Density alone should not be crippling: a tightly packed quarter of cottages
        // is normal and workable, but it will not become a manor district without
        // gardens, plazas and statues to lift it.
        const value = lv <= 5 ? -1 : lv <= 9 ? 1 : lv <= 13 ? 3 : 6;
        // Low housing drags only its immediate neighbours down; a fine house is
        // admired from further away.
        emit = { value, range: lv <= 5 ? 2 : 3, step: 1 };
      }
      if (!emit) continue;
      // Unbuilt monuments are building sites: unpleasant until finished.
      const scale = b.monument && !b.monument.complete ? -0.4 : 1;
      const value = emit.value * scale;
      const r = emit.range;
      for (let dy = -r; dy <= r + b.size - 1; dy++) {
        for (let dx = -r; dx <= r + b.size - 1; dx++) {
          const px = b.x + dx;
          const py = b.y + dy;
          if (!w.inBounds(px, py)) continue;
          // Chebyshev distance from the footprint edge.
          const ox = dx < 0 ? -dx : dx >= b.size ? dx - b.size + 1 : 0;
          const oy = dy < 0 ? -dy : dy >= b.size ? dy - b.size + 1 : 0;
          const d = Math.max(ox, oy);
          if (d > r) continue;
          const falloff = Math.max(0, 1 - (d * emit.step) / (r + 1));
          w.desirability[w.idx(px, py)] += Math.round(value * falloff);
        }
      }
    }

    // Terrain itself has an opinion: the river is pleasant, deep desert is not.
    for (let i = 0; i < w.area; i++) {
      const t = w.terrain[i];
      if (t === Terrain.Marsh) w.desirability[i] -= 4;
      else if (t === Terrain.Dune) w.desirability[i] -= 2;
      else if (w.nearWater[i]) w.desirability[i] += 3;
      if (w.road[i]) w.desirability[i] += 1;
    }
  }

  markDirty(): void {
    this.desirabilityDirty = true;
  }

  // -------------------------------------------------------------------------
  // Flood
  // -------------------------------------------------------------------------

  private stepFlood(): void {
    const yearT = (this.tick % TICKS_PER_YEAR) / TICKS_PER_YEAR;
    // The inundation swells through Akhet and drains away through early Peret.
    // Peak around month 2.
    let target = 0;
    if (yearT < 0.02) {
      this.nextFloodQuality = this.rollFloodQuality();
    }
    const riseStart = 0.0;
    const peak = 0.17;
    const fallEnd = 0.40;
    if (yearT >= riseStart && yearT < peak) {
      target = ((yearT - riseStart) / (peak - riseStart)) * this.nextFloodQuality;
    } else if (yearT < fallEnd) {
      target = (1 - (yearT - peak) / (fallEnd - peak)) * this.nextFloodQuality;
    } else {
      target = 0;
    }
    const prev = this.floodLevel;
    this.floodLevel = approach(this.floodLevel, clamp(target, 0, 1), 0.004);

    // Re-flag flooded tiles a few times a month rather than every tick.
    if (this.tick % 20 === 0) this.world.applyFlood(this.floodLevel);

    // As the waters recede past the threshold, silt is laid down — once per year.
    if (prev > 0.05 && this.floodLevel <= 0.05) {
      this.world.depositSilt(this.nextFloodQuality);
      this.floodQuality = this.nextFloodQuality;
      const q = this.nextFloodQuality;
      const desc =
        q > 0.85 ? 'a magnificent inundation' :
        q > 0.65 ? 'a good inundation' :
        q > 0.45 ? 'an adequate inundation' :
        q > 0.25 ? 'a poor inundation' : 'a failed inundation';
      this.pushMessage(
        'The waters recede',
        `The Nile has given you ${desc}. Your floodplain has been enriched accordingly.`,
        q > 0.6 ? 'good' : q > 0.35 ? 'info' : 'warn',
      );
    }
  }

  private rollFloodQuality(): number {
    // Osiris governs the river. A pleased god fills the fields; an angry one withholds.
    const base = 0.5 + (this.godMood.osiris / 100) * 0.35;
    return clamp(base + this.rng.float(-0.18, 0.18), 0.08, 1);
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  pushMessage(title: string, body: string, kind: CityMessage['kind'] = 'info', tile?: number): void {
    this.messages.unshift({
      id: this.nextMessageId++, tick: this.tick, title, body, kind, tile, read: false,
    });
    if (this.messages.length > 60) this.messages.length = 60;
  }

  get unreadMessages(): number {
    return this.messages.reduce((n, m) => n + (m.read ? 0 : 1), 0);
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /** Pick map-edge tiles where people and caravans enter and leave. */
  findEntryPoints(): void {
    const w = this.world;
    const N = w.size;
    const candidates: number[] = [];
    for (let x = 1; x < N - 1; x++) {
      for (const y of [1, N - 2]) {
        const i = w.idx(x, y);
        if (w.terrain[i] === Terrain.Floodplain || w.terrain[i] === Terrain.Desert || w.terrain[i] === Terrain.Grass) {
          candidates.push(i);
        }
      }
    }
    for (let y = 1; y < N - 1; y++) {
      for (const x of [1, N - 2]) {
        const i = w.idx(x, y);
        if (w.terrain[i] === Terrain.Floodplain || w.terrain[i] === Terrain.Desert || w.terrain[i] === Terrain.Grass) {
          candidates.push(i);
        }
      }
    }
    if (candidates.length) {
      this.entryTile = candidates[Math.floor(candidates.length * 0.25)];
      this.exitTile = candidates[Math.floor(candidates.length * 0.75)];
    }
  }

  /** Total units of a good held anywhere the player controls. */
  totalStored(g: GoodId): number {
    let n = 0;
    for (const id of this.liveBuildings) {
      const b = this.buildings[id];
      if (!b) continue;
      n += b.store[g] ?? 0;
    }
    return n;
  }
}
