/**
 * The systems that sit on top of the tick loop: logistics between workshops, monument
 * construction, the pantheon, trade, war, disasters, and the four ratings Pharaoh
 * judges you by.
 *
 * These are kept out of `City` so the core tick stays readable, and so each system can
 * choose its own cadence — logistics wants to run often, the gods once a month.
 */

import { clamp } from './core';
import {
  BUILDING_BY_ID, GOODS, GoodId, GodId, GOD_IDS, GODS, FOOD_IDS, HOUSEHOLD_GOODS,
  HOUSING, ALL_GOOD_IDS,
} from './data';
import { TICKS_PER_MONTH, TICKS_PER_YEAR } from './consts';
import { Terrain } from './world';
import type { Building, City, TradeRoute, PharaohRequest, Invasion } from './sim';

export type TradePolicy = 'none' | 'import' | 'export';

/** One diagnosed fault in the city, ranked by how much it matters. */
export interface CityProblem {
  severity: number;
  title: string;
  /** Plain language, names the cause and the fix. */
  cause: string;
  tile?: number;
  buildingId?: number;
}

/** Which guild hauls which material to a monument site. */
const GUILD_MATERIALS: Record<string, GoodId[]> = {
  bricklayer_guild: ['bricks'],
  stonemason_guild: ['limestone', 'sandstone', 'granite'],
  carpenter_guild: ['timber'],
  artisan_guild: ['gold', 'gems'],
};

export class Systems {
  city: City;
  tradePolicy: Partial<Record<GoodId, TradePolicy>> = {};
  /** Per-good import/export ceilings so the player can throttle a route. */
  tradeLimit: Partial<Record<GoodId, number>> = {};

  private logisticsTimer = 0;
  private performerTimer = 0;
  private monumentTimer = 0;
  private monthTimer = 0;
  private lastMonth = -1;
  private monthDelay = 0;
  private lastYear = -1;

  /** Festival being prepared, if any. */
  festival: { god: GodId; scale: 'modest' | 'lavish' | 'grand'; atTick: number } | null = null;

  constructor(city: City) {
    this.city = city;
  }

  step(): void {
    const city = this.city;

    if (++this.logisticsTimer >= 90) {
      this.logisticsTimer = 0;
      this.runLogistics();
      this.runWorkCamps();
    }
    if (++this.monumentTimer >= 45) {
      this.monumentTimer = 0;
      this.runMonuments();
    }
    if (++this.performerTimer >= 120) {
      this.performerTimer = 0;
      this.runPerformers();
      this.runGetOrders();
    }

    // The pantheon, ratings and disasters run a few ticks into the month, after the
    // city's own monthly pass (which is itself spread over six ticks), so none of them
    // share a frame.
    const m = city.month;
    if (m !== this.lastMonth) {
      this.lastMonth = m;
      this.monthDelay = 8;
    }
    if (this.monthDelay > 0 && --this.monthDelay === 0) this.runMonth();
    const y = city.year;
    if (y !== this.lastYear) {
      this.lastYear = y;
      this.runYear();
    }

    this.runFestival();
    this.runCombat();
  }

  // -------------------------------------------------------------------------
  // Diagnosis
  // -------------------------------------------------------------------------

  /**
   * Everything currently wrong with the city, ranked. This is the single source of
   * truth behind both the Problems overlay and the chief advisor, so the map and the
   * panel can never disagree about what is broken.
   *
   * The principle throughout: name the cause, not the symptom. "Understaffed" is a
   * symptom. "No storage will accept its pottery" is a cause the player can act on.
   */
  cityProblems(limit = 40): CityProblem[] {
    const city = this.city;
    const out: CityProblem[] = [];
    const add = (severity: number, title: string, cause: string, tile?: number, buildingId?: number) =>
      out.push({ severity, title, cause, tile, buildingId });

    // City-wide first: these outrank any single building.
    if (city.funds < 0) {
      add(100, 'The treasury is empty',
        `You are ${Math.round(-city.funds)} deben in debt. Raise taxes, export more, or stop building.`);
    }
    const foodMonths = city.foodMonthsRemaining();
    if (city.population > 0 && foodMonths < 1) {
      add(95, 'The city is running out of food',
        `About ${foodMonths.toFixed(1)} months left. Build farms, or import food through a trade route.`);
    }
    if (city.stats.workersNeeded > city.workforce * 1.15 && city.workforce > 0) {
      add(80, 'Labour shortage',
        `${city.workforce} workers for ${city.stats.workersNeeded} jobs. House more people, mothball what you do not need, or reorder the labour advisor.`);
    }
    if (city.sentiment < 30) add(78, 'Your people are unhappy', city.sentimentCause);
    for (const g of GOD_IDS) {
      if (city.godMood[g] < -55) {
        add(76, `${GODS[g].name} is angry`,
          `Build temples to ${GODS[g].name} or hold a festival before the wrath falls.`);
      }
    }
    for (const inv of city.invasions) {
      if (!inv.landed && city.tick > inv.arrivalTick - TICKS_PER_MONTH * 6) {
        add(85, 'Invasion coming', `${inv.enemy}, strength ${inv.strength}. Muster your forts.`, inv.entryTile);
      }
    }

    // Then per building.
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b || !b.built) continue;
      const def = city.def(b);
      const tile = city.world.idx(b.x, b.y);

      if (b.fire > 88) {
        add(90, `${def.name} is about to burn`, 'A firehouse walker must reach it.', tile, id);
        continue;
      }
      if (b.damage > 88) {
        add(86, `${def.name} is about to collapse`, "An architect's post must reach it.", tile, id);
        continue;
      }
      if (def.needsRoad && !b.hasRoad) {
        add(70, `${def.name} has no road`, 'Nothing can reach it and it does nothing. Connect it.', tile, id);
        continue;
      }
      if (city.workersFor(b) > 0 && b.staffing <= 0 && b.enabled) {
        add(62, `${def.name} has no workers`,
          'Its whole sector is being outbid. Raise it in the labour advisor or house more people.', tile, id);
        continue;
      }
      if (b.monument && !b.monument.complete) {
        const stall = this.monumentStall(b);
        if (stall) add(74, `${def.name} has stalled`, stall, tile, id);
        continue;
      }
      if (def.needsPerformerFrom && (b.performers ?? 0) <= 0) {
        const school = BUILDING_BY_ID[def.needsPerformerFrom]?.name ?? def.needsPerformerFrom;
        add(58, `${def.name} stands empty`,
          `No performer. Build a ${school.toLowerCase()} within reach of it.`, tile, id);
        continue;
      }
      if (b.campFarm && !(b.tended ?? 0)) {
        const centre = city.world.idx(b.x + (b.size >> 1), b.y + (b.size >> 1));
        if (!city.world.flooded[centre]) {
          const camps = city.countOf('work_camp');
          add(66, `${def.name} lies fallow`, camps
            ? 'No peasants are reaching it. A work camp only sends them to farms within reach along its roads — build one closer, or give it more workers.'
            : 'Floodplain farms are worked by peasants from a work camp, and you have none. Build one near the fields.', tile, id);
          continue;
        }
      }
      if (def.produces) {
        const outputs: [GoodId, number][] = [[def.produces, def.produceQty ?? 8]];
        for (const [g, q] of Object.entries(def.alsoProduces ?? {})) outputs.push([g as GoodId, q as number]);
        const stuck = outputs.find(([g, q]) => (b.store[g] ?? 0) >= q * 2);
        if (stuck) {
          const name = GOODS[stuck[0]].name.toLowerCase();
          const store = GOODS[stuck[0]].kind === 'food' ? 'granary' : 'storage yard';
          add(60, `${def.name} cannot deliver its ${name}`,
            `It is piling up at the ${def.cat === 'food' ? 'farm' : 'workshop'}. No ${store} will take it — build one, or set an existing one to accept ${name}.`, tile, id);
          continue;
        }
      }
      if (def.consumes && b.staffing > 0) {
        for (const [gRaw, needRaw] of Object.entries(def.consumes)) {
          const g = gRaw as GoodId;
          if ((b.store[g] ?? 0) < (needRaw as number) && city.totalStored(g) <= 0) {
            add(56, `${def.name} is idle`,
              `Waiting for ${GOODS[g].name.toLowerCase()}, and the city has none.`, tile, id);
            break;
          }
        }
      }
      if (def.id === 'bazaar' && b.staffing > 0) {
        const stock = Object.values(b.store).reduce((a: number, v) => a + (v ?? 0), 0);
        if (stock < 2) {
          add(64, 'Bazaar has nothing to sell',
            'Its buyer cannot find a stocked granary or storage yard in reach. Put one closer.', tile, id);
        }
      }
    }

    // Housing blockers, aggregated: forty houses stuck on the same thing is one problem.
    const blockers = new Map<string, { n: number; tile: number }>();
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b?.house || b.house.people <= 0 || !b.house.blocker) continue;
      const e = blockers.get(b.house.blocker);
      if (e) e.n++;
      else blockers.set(b.house.blocker, { n: 1, tile: city.world.idx(b.x, b.y) });
    }
    for (const [blocker, e] of blockers) {
      if (e.n < 3) continue;
      add(40 + Math.min(20, e.n), `${e.n} houses cannot improve`, blocker, e.tile);
    }

    // Fold repeats. Twenty workshops all short of clay is one problem with a count,
    // not twenty rows: a fault list that scrolls is a fault list nobody reads, which is
    // the whole reason this panel exists on a phone. The first of each kind keeps its
    // location so the entry stays one tap from somewhere worth looking.
    const folded: CityProblem[] = [];
    const byKind = new Map<string, CityProblem & { n: number }>();
    for (const p of out) {
      // Group by the sentence, not the building: "Potter has no workers" and "Brewery
      // has no workers" share a cause and a fix.
      const key = `${p.severity}|${p.cause}`;
      const seen = byKind.get(key);
      if (seen) {
        seen.n++;
        continue;
      }
      const entry = { ...p, n: 1 };
      byKind.set(key, entry);
      folded.push(entry);
    }
    for (const p of folded) {
      const n = (p as CityProblem & { n: number }).n;
      if (n > 1) p.title = `${p.title} (and ${n - 1} more like it)`;
    }

    folded.sort((a, b) => b.severity - a.severity);
    return folded.slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Logistics: keep workshops fed from storage
  // -------------------------------------------------------------------------

  /**
   * Workshops do not fetch their own raw materials in Pharaoh — storage yards push
   * them out. Any workshop short of an input gets a cart from the nearest yard holding
   * that input, provided a road connects them.
   */
  private runLogistics(): void {
    const city = this.city;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b || !b.built || !b.hasRoad || !b.enabled) continue;
      const def = city.def(b);
      if (!def.consumes) continue;
      if (b.walkers.length > 2) continue;

      for (const [gRaw, needRaw] of Object.entries(def.consumes)) {
        const g = gRaw as GoodId;
        const need = needRaw as number;
        const have = b.store[g] ?? 0;
        if (have >= need * 3) continue;

        const source = this.findYardWith(b, g, need);
        if (source < 0) continue;
        const src = city.buildings[source]!;
        const qty = Math.min(src.store[g] ?? 0, need * 4);
        if (qty < need) continue;
        if (city.walkers.spawnSupply(src, b, g, qty)) break;
      }
    }
  }

  /**
   * Floodplain farms that need peasants and that this camp could send them to: dry
   * (nothing to plant under water), low on banked labour, within a day's walk, and not
   * already being walked to. Nearest first.
   */
  farmWorkFor(camp: Building): Building[] {
    const city = this.city;
    const out: { b: Building; d: number }[] = [];
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b?.campFarm || !b.built || !b.hasRoad || !b.enabled) continue;
      const centre = city.world.idx(b.x + (b.size >> 1), b.y + (b.size >> 1));
      if (city.world.flooded[centre]) continue;
      if ((b.tended ?? 0) > TICKS_PER_MONTH * 1.5) continue;
      const d = Math.abs(b.x - camp.x) + Math.abs(b.y - camp.y);
      if (d > 45) continue;
      out.push({ b, d });
    }
    return out.sort((a, b) => a.d - b.d).map((e) => e.b);
  }

  /** Work camps send peasants out to the floodplain farms. */
  private runWorkCamps(): void {
    const city = this.city;
    // Farms that already have someone on the way do not need a second walker yet.
    const enRoute = new Set<number>();
    for (const wid of city.walkers.live) {
      const w = city.walkers.get(wid);
      if (w?.kind === 'laborer' && w.target >= 0) enRoute.add(w.target);
    }
    for (const id of city.liveBuildings) {
      const camp = city.buildings[id];
      if (!camp || camp.defId !== 'work_camp' || !camp.built || !camp.hasRoad) continue;
      if (camp.staffing <= 0 || camp.walkers.length >= 4) continue;
      // A half-staffed camp sends half as many.
      if (!city.rng.chance(clamp(camp.staffing, 0.2, 1))) continue;
      const farm = this.farmWorkFor(camp).find((f) => !enRoute.has(f.id));
      if (!farm) continue;
      if (city.walkers.spawnLaborer(camp, farm)) enRoute.add(farm.id);
    }
  }

  /**
   * Schools send performers to venues. The venue is the thing the player sees standing
   * idle, but the school is the thing that was missing, so the link is explicit.
   */
  private runPerformers(): void {
    const city = this.city;
    for (const id of city.liveBuildings) {
      const venue = city.buildings[id];
      if (!venue || !venue.built || !venue.hasRoad) continue;
      const def = city.def(venue);
      if (!def.needsPerformerFrom) continue;
      if ((venue.performers ?? 0) > 0.55) continue;

      for (const sid of city.liveBuildings) {
        const school = city.buildings[sid];
        if (!school || school.defId !== def.needsPerformerFrom) continue;
        if (!school.built || !school.hasRoad || school.staffing <= 0) continue;
        const entrance = city.world.roadEntrance(school.x, school.y, school.size);
        if (entrance < 0) continue;
        // Reuse the supply walker: a performer is a purposeful walker with no cargo.
        if (city.walkers.spawnSupply(school, venue, 'papyrus', 0)) {
          venue.performers = 1;
          break;
        }
      }
    }
  }

  /**
   * A store set to Get a good dispatches carts to fetch it from stores that hold it.
   * This is how food crosses a city from the farming district to the housing district
   * without every bazaar buyer making the trip itself.
   */
  private runGetOrders(): void {
    const city = this.city;
    for (const id of city.liveBuildings) {
      const dest = city.buildings[id];
      if (!dest?.orders || !dest.built || !dest.hasRoad || dest.staffing <= 0) continue;
      const def = city.def(dest);
      if (!def.storage) continue;
      const used = Object.values(dest.store).reduce((a: number, v) => a + (v ?? 0), 0);
      if (used >= def.storage) continue;
      if (dest.walkers.length >= 2) continue;

      for (const [gRaw, order] of Object.entries(dest.orders)) {
        if (order !== 'get') continue;
        const g = gRaw as GoodId;
        if ((dest.store[g] ?? 0) > 40) continue;
        const src = this.findYardWith(dest, g, 8);
        if (src < 0 || src === id) continue;
        const from = city.buildings[src]!;
        const qty = Math.min(from.store[g] ?? 0, 30);
        if (qty < 4) continue;
        if (city.walkers.spawnSupply(from, dest, g, qty)) break;
      }
    }
  }

  /**
   * Why a monument is not advancing, in the order the causes actually occur. On desktop
   * a player finds these by clicking through five buildings; naming the cause is not
   * hand holding, hiding it behind five taps is just friction.
   */
  monumentStall(site: Building): string | null {
    const city = this.city;
    const def = city.def(site);
    if (!def.monument || site.monument?.complete) return null;
    const stage = def.monument.stages[site.monument!.stage];
    if (!stage) return null;

    const needed = (Object.keys(stage.materials) as GoodId[])
      .filter((g) => (site.monument!.delivered[g] ?? 0) < (stage.materials[g] ?? 0));

    for (const g of needed) {
      const name = GOODS[g].name.toLowerCase();
      const producedAnywhere = city.liveBuildings.some((i) => {
        const b = city.buildings[i];
        return b && city.def(b).produces === g;
      }) || city.totalStored(g) > 0;
      if (!producedAnywhere) {
        return `You have no source of ${name}. Build a quarry or workshop for it, or open a trade route.`;
      }
      const inStore = city.liveBuildings.some((i) => {
        const b = city.buildings[i];
        return b && (b.defId === 'storage_yard' || b.defId === 'granary') && (b.store[g] ?? 0) >= 4;
      });
      if (!inStore) {
        return `No ${name} is reaching the site. Set a nearby storage yard to Get ${name}.`;
      }
    }

    const camps = city.liveBuildings
      .map((i) => city.buildings[i])
      .filter((b) => b?.defId === 'work_camp');
    if (!camps.length) return 'There are no labourers. Build a work camp near the site.';
    if (!camps.some((b) => b!.staffing > 0)) {
      return 'Your work camps have no workers. Raise Monuments in the labour advisor, or house more people.';
    }

    for (const g of needed) {
      const guild = Object.entries(GUILD_MATERIALS).find(([, mats]) => mats.includes(g));
      if (!guild) continue;
      const have = city.liveBuildings.some((i) => {
        const b = city.buildings[i];
        return b?.defId === guild[0] && b.staffing > 0;
      });
      if (!have) {
        const label = BUILDING_BY_ID[guild[0]]?.name ?? guild[0];
        return `This phase needs a ${label.toLowerCase()}. Build one and make sure it is staffed.`;
      }
    }

    if (site.monument!.laborDone < stage.labor && city.stats.workersNeeded > city.workforce) {
      return 'Monument workers are being outbid elsewhere. Raise Monuments in the labour advisor.';
    }
    return null;
  }

  /**
   * The reachability halo: every road tile a walker leaving this building could still
   * be standing on before its wander budget runs out, and every house beside one.
   *
   * Nothing here changes the simulation. It makes visible what an expert computes in
   * their head and a novice never learns, which is why it is offered on every building
   * that sends a walker out, and gated behind nothing.
   */
  reachabilityHalo(site: Building): { roads: number[]; served: number[]; range: number } | null {
    const city = this.city;
    const w = city.world;
    const def = city.def(site);
    const range = def.walkerRange ?? 0;
    if (!range) return null;
    const entrance = w.roadEntrance(site.x, site.y, site.size);
    if (entrance < 0) return { roads: [], served: [], range };

    const roads = w.roadsWithin(entrance, range);
    // A house is served by standing beside a road the walker uses, not on it, so the
    // served set is the one-tile skirt around the halo.
    const served: number[] = [];
    const seen = new Set<number>();
    const around: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const t of roads) {
      const x = w.xOf(t);
      const y = w.yOf(t);
      for (const [dx, dy] of around) {
        if (!w.inBounds(x + dx, y + dy)) continue;
        const id = w.building[w.idx(x + dx, y + dy)];
        if (id < 0 || seen.has(id)) continue;
        const b = city.buildings[id];
        if (!b?.house) continue;
        seen.add(id);
        for (let by = 0; by < b.size; by++) {
          for (let bx = 0; bx < b.size; bx++) {
            if (w.inBounds(b.x + bx, b.y + by)) served.push(w.idx(b.x + bx, b.y + by));
          }
        }
      }
    }
    return { roads, served, range };
  }

  private findYardWith(from: Building, good: GoodId, min: number): number {
    const city = this.city;
    const kind = GOODS[good].kind === 'food' ? 'granary' : 'storage_yard';
    let best = -1;
    let bestD = Infinity;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b || b.defId !== kind || !b.hasRoad || !b.built) continue;
      if ((b.store[good] ?? 0) < min) continue;
      const d = Math.abs(b.x - from.x) + Math.abs(b.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Monuments
  // -------------------------------------------------------------------------

  private runMonuments(): void {
    const city = this.city;
    const sites: Building[] = [];
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (b?.monument && !b.monument.complete) sites.push(b);
    }
    if (!sites.length) return;

    for (const site of sites) {
      const def = city.def(site);
      const stages = def.monument!.stages;
      const st = site.monument!;
      if (st.stage >= stages.length) {
        this.completeMonument(site);
        continue;
      }
      const stage = stages[st.stage];

      // Guilds haul materials.
      for (const id of city.liveBuildings) {
        const g = city.buildings[id];
        if (!g || !g.built || !g.hasRoad || g.staffing <= 0) continue;
        const mats = GUILD_MATERIALS[g.defId];
        if (!mats) continue;
        if (g.walkers.length >= 2) continue;

        for (const mat of mats) {
          const required = stage.materials[mat] ?? 0;
          if (!required) continue;
          const delivered = st.delivered[mat] ?? 0;
          if (delivered >= required) continue;

          const yard = this.findYardWith(g, mat, 8);
          if (yard < 0) continue;
          const src = city.buildings[yard]!;
          const qty = Math.min(src.store[mat] ?? 0, required - delivered, 20);
          if (qty < 4) continue;
          // The guild collects from the yard and carries straight to the site.
          if (city.walkers.spawnSupply(src, site, mat, qty)) break;
        }
      }

      // Work camps supply labour.
      const labourNeeded = stage.labor - st.laborDone;
      if (labourNeeded > 0) {
        for (const id of city.liveBuildings) {
          const camp = city.buildings[id];
          if (!camp || camp.defId !== 'work_camp' || !camp.hasRoad || camp.staffing <= 0) continue;
          if (camp.walkers.length >= 3) continue;
          // The fields come first. While there is planting or harvest to do the camp's
          // peasants are on the farms; it is the flood that frees them for the monument.
          if (this.farmWorkFor(camp).length) continue;
          city.walkers.spawnLaborer(camp, site);
        }
      }

      // Materials arrive as store entries on the site; fold them into `delivered`.
      for (const g of Object.keys(site.store) as GoodId[]) {
        const amt = site.store[g] ?? 0;
        if (amt <= 0) continue;
        st.delivered[g] = (st.delivered[g] ?? 0) + amt;
        delete site.store[g];
      }

      // Stage complete?
      let materialsMet = true;
      for (const [gRaw, reqRaw] of Object.entries(stage.materials)) {
        if ((st.delivered[gRaw as GoodId] ?? 0) < (reqRaw as number)) {
          materialsMet = false;
          break;
        }
      }
      if (materialsMet && st.laborDone >= stage.labor) {
        st.stage++;
        st.laborDone = 0;
        st.delivered = {};
        site.built = st.stage / stages.length;
        if (st.stage >= stages.length) {
          this.completeMonument(site);
        } else {
          city.pushMessage(
            `${def.name}: stage complete`,
            `Your workers have finished "${stage.name}". Next: ${stages[st.stage].name}.`,
            'good',
            city.world.idx(site.x, site.y),
          );
        }
      }
    }
  }

  private completeMonument(site: Building): void {
    const city = this.city;
    const def = city.def(site);
    site.monument!.complete = true;
    site.built = 1;
    city.ratings.monument = clamp(city.ratings.monument + def.monument!.points, 0, 100);
    city.ratings.kingdom = clamp(city.ratings.kingdom + 4, 0, 100);
    for (const g of GOD_IDS) city.godMood[g] = clamp(city.godMood[g] + 8, -100, 100);
    city.pushMessage(
      `${def.name} completed`,
      `The ${def.name.toLowerCase()} stands finished. It will be seen from the river for a thousand years, and Pharaoh has taken note.`,
      'good',
      city.world.idx(site.x, site.y),
    );
    city.markDirty();
  }

  /** Fraction 0..1 of the current stage that is done, for the UI. */
  monumentProgress(b: Building): { stage: number; total: number; label: string; frac: number } {
    const def = this.city.def(b);
    const stages = def.monument!.stages;
    const st = b.monument!;
    if (st.complete) return { stage: stages.length, total: stages.length, label: 'Complete', frac: 1 };
    const stage = stages[st.stage];
    let matHave = 0;
    let matNeed = 0;
    for (const [g, req] of Object.entries(stage.materials)) {
      matNeed += req as number;
      matHave += Math.min(st.delivered[g as GoodId] ?? 0, req as number);
    }
    const labFrac = stage.labor ? clamp(st.laborDone / stage.labor, 0, 1) : 1;
    const matFrac = matNeed ? matHave / matNeed : 1;
    return {
      stage: st.stage + 1,
      total: stages.length,
      label: stage.name,
      frac: (labFrac + matFrac) / 2,
    };
  }

  // -------------------------------------------------------------------------
  // Monthly pass
  // -------------------------------------------------------------------------

  private runMonth(): void {
    this.updateGods();
    this.updateRatings();
    this.runDisasters();
    this.runTrade();
    this.runMilitary();
    this.updateRequests();
  }

  private runYear(): void {
    for (const r of this.city.trade) {
      r.soldThisYear = {};
      r.boughtThisYear = {};
    }
  }

  // -------------------------------------------------------------------------
  // Religion
  // -------------------------------------------------------------------------

  /**
   * Each god weighs the worship it receives against the size of your city.
   *
   * The demand starts near nothing and grows with the city, because a hamlet of sixty
   * people owes the pantheon very little. The previous curve charged a flat hundred and
   * twenty per god before population even entered the sum, which a village could not
   * meet at any level of skill — five staffed temples cost more workers than it had —
   * so the whole pantheon turned hostile inside two years of every game, regardless of
   * how well it was played. That is not difficulty, it is a bill you cannot pay.
   *
   * Falling out of favour is also deliberately much slower than climbing back into it.
   * Neglect should take years to become dangerous and one festival to begin undoing.
   */
  private updateGods(): void {
    const city = this.city;
    const pop = Math.max(1, city.population);

    for (const g of GOD_IDS) {
      let worship = 0;
      for (const id of city.liveBuildings) {
        const b = city.buildings[id];
        if (!b || !b.built) continue;
        const def = city.def(b);
        if (def.god !== g) continue;
        if (def.id.startsWith('shrine_')) worship += 60;
        else if (def.id.startsWith('temple_')) worship += b.staffing > 0 ? 320 : 90;
        else if (def.id.startsWith('complex_')) worship += b.staffing > 0 ? 1600 : 380;
      }
      // An oracle placates the whole pantheon a little.
      worship += city.countOf('oracle') * 120;

      // A shrine each — 60 apiece, no workers, 60 deben — holds a village of a hundred.
      const needed = 25 + pop * 0.85;
      const ratio = worship / needed;
      // Asymmetric on purpose: neglect drifts, devotion recovers.
      let delta = ratio >= 1 ? Math.min((ratio - 1) * 6, 6) : Math.max((ratio - 1) * 2.4, -1.6);

      // A city that never holds a festival at all is a city the gods eventually notice.
      city.godFestival[g]++;
      if (city.godFestival[g] > 60) delta -= 0.5;

      city.godMood[g] = clamp(city.godMood[g] + delta, -100, 100);
    }

    this.applyGodEffects();
  }

  /**
   * Blessings and wrath.
   *
   * Wrath needs a god to have been furious for the better part of a year, and having
   * struck once it will not strike again for a good while. A single unlucky roll the
   * month a god crosses the threshold gave no chance to react and no sense that the
   * city had earned it — and with five gods on independent rolls, something was always
   * going wrong somewhere.
   */
  private applyGodEffects(): void {
    const city = this.city;
    const youngCity = city.tick < TICKS_PER_YEAR * 3;

    for (const g of GOD_IDS) {
      const mood = city.godMood[g];
      if (city.godWrathCooldown[g] > 0) city.godWrathCooldown[g]--;

      if (mood < -70) city.godAnger[g]++;
      else city.godAnger[g] = 0;

      if (mood > 78 && city.rng.chance(0.12)) {
        this.blessing(g);
        continue;
      }
      // Ten months of sustained fury, no recent strike, and not in the opening years,
      // when a governor is still laying roads and has nothing to give anyone.
      if (mood < -70 && city.godAnger[g] >= 10 && city.godWrathCooldown[g] === 0 && !youngCity) {
        if (city.rng.chance(0.10)) {
          this.wrath(g);
          city.godAnger[g] = 0;
          city.godWrathCooldown[g] = 24;
          // Having taken their due, the god is partly satisfied. Without this a city
          // that fell to -100 stayed there — every god firing on its own cooldown
          // forever, a wrath every few months, while the wreckage made recovery
          // impossible. Punishment has to have an end the player can reach.
          city.godMood[g] = Math.max(city.godMood[g], -45);
        }
      }
    }
  }

  private blessing(g: GodId): void {
    const city = this.city;
    const god = GODS[g];
    switch (g) {
      case 'osiris':
        city.nextFloodQuality = clamp(city.nextFloodQuality + 0.25, 0, 1);
        break;
      case 'ra':
        for (const id of city.liveBuildings) {
          const b = city.buildings[id];
          if (b && city.def(b).cat === 'food') b.store[city.def(b).produces!] = (b.store[city.def(b).produces!] ?? 0) + 40;
        }
        break;
      case 'ptah':
        for (const id of city.liveBuildings) {
          const b = city.buildings[id];
          if (b?.defId === 'storage_yard') {
            for (const gd of ['pottery', 'linen', 'beer'] as GoodId[]) b.store[gd] = (b.store[gd] ?? 0) + 30;
          }
        }
        break;
      case 'seth':
        for (const id of city.liveBuildings) {
          const b = city.buildings[id];
          if (b?.garrison) b.garrison.morale = 100;
        }
        break;
      case 'bast':
        for (const id of city.liveBuildings) {
          const b = city.buildings[id];
          if (b?.house) b.house.health = 100;
        }
        break;
    }
    city.pushMessage(`${god.name} smiles upon you`, god.blessing, 'good');
  }

  private wrath(g: GodId): void {
    const city = this.city;
    const god = GODS[g];
    switch (g) {
      case 'osiris':
        city.nextFloodQuality = clamp(city.nextFloodQuality - 0.4, 0.05, 1);
        break;
      case 'ra': {
        // Ra's anger makes the city tinder-dry. It does not light the fires itself:
        // setting buildings straight to a hundred and twenty destroyed three or four
        // at once with no warning and nothing a firehouse could do, which reads as the
        // game taking a turn rather than as a hazard the player failed to manage.
        //
        // Capped at the threshold that puts a building on the fault list, so the player
        // gets four named alarms and roughly three months to answer them — not five
        // buildings quietly sitting one point below ignition.
        const ids = city.liveBuildings.filter((i) => city.buildings[i]);
        for (let k = 0; k < 4 && ids.length; k++) {
          const b = city.buildings[city.rng.pick(ids)];
          if (b) b.fire = Math.min(89, b.fire + 45);
        }
        break;
      }
      case 'ptah':
        for (const id of city.liveBuildings) {
          const b = city.buildings[id];
          if (b && city.def(b).cat === 'industry' && city.rng.chance(0.3)) {
            b.damage = Math.min(89, b.damage + 45);
          }
        }
        break;
      case 'seth': {
        // Seth escalates. The first strikes hollow out the army and set the city on
        // edge; only sustained neglect brings the raiders. Opening with an invasion
        // every time gave a city with no fort no answer at all, and no warning that
        // one was needed.
        const strikes = city.sethStrikes++;
        if (strikes < 2) {
          for (const id of city.liveBuildings) {
            const b = city.buildings[id];
            if (b?.garrison) {
              b.garrison.morale = Math.max(20, b.garrison.morale - 45);
              b.garrison.strength = Math.max(0, Math.round(b.garrison.strength * 0.7));
            }
          }
          city.sentiment = Math.max(0, city.sentiment - 12);
          break;
        }
        // A year's warning, and a raid sized to the city rather than a flat ten.
        this.scheduleInvasion(
          city.tick + TICKS_PER_YEAR,
          'Followers of Seth',
          clamp(Math.round(city.population / 70), 3, 12),
        );
        break;
      }
      case 'bast':
        for (const id of city.liveBuildings) {
          const b = city.buildings[id];
          if (b?.house && city.rng.chance(0.3)) {
            b.house.health = Math.max(30, b.house.health - 40);
          }
        }
        break;
    }
    city.pushMessage(`${god.name} is angered`, god.wrath, 'bad');
  }

  /** Hold a festival. Returns false if the city cannot afford it. */
  holdFestival(god: GodId, scale: 'modest' | 'lavish' | 'grand'): boolean {
    const city = this.city;
    if (!city.countOf('festival_square')) return false;
    if (this.festival) return false;
    const cost = scale === 'modest' ? 150 : scale === 'lavish' ? 400 : 900;
    if (city.funds < cost) return false;
    city.funds -= cost;
    this.festival = { god, scale, atTick: city.tick + TICKS_PER_MONTH * 2 };
    city.pushMessage(
      `A festival is proclaimed`,
      `Preparations begin for a ${scale} festival in honour of ${GODS[god].name}. It will be held in two months.`,
      'info',
    );
    return true;
  }

  private runFestival(): void {
    const f = this.festival;
    if (!f) return;
    const city = this.city;
    if (city.tick < f.atTick) return;
    const boost = f.scale === 'modest' ? 18 : f.scale === 'lavish' ? 34 : 55;
    city.godMood[f.god] = clamp(city.godMood[f.god] + boost, -100, 100);
    city.godFestival[f.god] = 0;
    // Everyone enjoys a holiday.
    for (const g of GOD_IDS) if (g !== f.god) city.godMood[g] = clamp(city.godMood[g] + 4, -100, 100);
    city.ratings.culture = clamp(city.ratings.culture + 2, 0, 100);
    city.pushMessage(
      'The festival is held',
      `The image of ${GODS[f.god].name} is carried in procession through your streets. The god is well pleased.`,
      'good',
    );
    this.festival = null;
  }

  // -------------------------------------------------------------------------
  // Ratings
  // -------------------------------------------------------------------------

  private updateRatings(): void {
    const city = this.city;
    let houses = 0;
    let withTemple = 0;
    let withSchool = 0;
    let withEnt = 0;
    let prosperitySum = 0;
    let peopleSum = 0;

    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b?.house || b.house.people <= 0) continue;
      houses++;
      const s = b.house.services;
      if (GOD_IDS.some((g) => s[`religion${g[0].toUpperCase()}${g.slice(1)}` as any])) withTemple++;
      if (s.school || s.library) withSchool++;
      if (s.booth || s.bandstand || s.pavilion || s.senet) withEnt++;
      prosperitySum += HOUSING[b.house.level].prosperity * b.house.people;
      peopleSum += b.house.people;
    }

    if (houses > 0) {
      const culture = ((withTemple / houses) * 40 + (withSchool / houses) * 32 + (withEnt / houses) * 28);
      city.ratings.culture = Math.round(clamp(
        city.ratings.culture + clamp(culture - city.ratings.culture, -3, 3), 0, 100));
    }

    if (peopleSum > 0) {
      // Prosperity compares your average house against the top of the ladder, with a
      // bonus for a healthy treasury and a penalty for debt.
      const avg = prosperitySum / peopleSum;
      let target = (avg / HOUSING[HOUSING.length - 1].prosperity) * 100;
      target += clamp(city.funds / 400, -20, 12);
      target += city.countOf('mansion') * 4;
      target -= city.unemployment > 0.15 ? 10 : 0;
      city.ratings.prosperity = Math.round(clamp(
        city.ratings.prosperity + clamp(target - city.ratings.prosperity, -3, 3), 0, 100));
    }

    // Kingdom drifts toward neutral when nothing is happening.
    const drift = city.ratings.kingdom < 50 ? 0.35 : city.ratings.kingdom > 50 ? -0.15 : 0;
    city.ratings.kingdom = clamp(city.ratings.kingdom + drift, 0, 100);
  }

  // -------------------------------------------------------------------------
  // Disasters
  // -------------------------------------------------------------------------

  /**
   * Fire, collapse, plague and theft.
   *
   * All of them are held off entirely for the first two years. A governor laying their
   * first roads has neither the workers to staff a firehouse nor the money to build
   * one, so a disaster in year one is not a lesson, it is a coin toss that ends the
   * mission. After that they are real, and every one of them is preceded by a warning
   * on the fault list well before it fires.
   */
  private runDisasters(): void {
    const city = this.city;
    if (city.tick < TICKS_PER_YEAR * 2) return;

    for (const id of [...city.liveBuildings]) {
      const b = city.buildings[id];
      if (!b || !b.built) continue;

      if (b.fire >= 100 && city.rng.chance(0.18)) {
        this.burn(b);
        continue;
      }
      if (b.damage >= 100 && city.rng.chance(0.14)) {
        city.pushMessage(
          'A building has collapsed',
          `Neglected walls have given way. An architect's post nearby would have prevented this.`,
          'bad',
          city.world.idx(b.x, b.y),
        );
        city.demolish(b.x, b.y);
      }
    }

    // Disease. Marsh-side districts with poor health and an angry Bast suffer.
    if (city.stats.avgHealth < 32 && city.rng.chance(0.12)) {
      let struck = 0;
      for (const id of city.liveBuildings) {
        const b = city.buildings[id];
        if (!b?.house || b.house.people <= 0) continue;
        if (b.house.health > 38) continue;
        if (!city.rng.chance(0.22)) continue;
        const lost = Math.ceil(b.house.people * 0.15);
        b.house.people -= lost;
        city.population -= lost;
        b.house.health = Math.max(5, b.house.health - 20);
        struck++;
      }
      if (struck) {
        city.pushMessage(
          'Plague',
          `Sickness has swept through ${struck} households. Physicians and clean water are the only defence.`,
          'bad',
        );
        city.ratings.kingdom = clamp(city.ratings.kingdom - 2, 0, 100);
      }
    }

    // Tomb robbers go after a finished monument if the city is lawless.
    if (city.stats.crime > 55 && city.rng.chance(0.04)) {
      city.funds -= 200;
      city.pushMessage(
        'Tomb robbers',
        'Thieves have broken into a monument and made off with grave goods. Courthouses would deter them.',
        'bad',
      );
      city.ratings.kingdom = clamp(city.ratings.kingdom - 3, 0, 100);
    }
  }

  private burn(b: Building): void {
    const city = this.city;
    const tile = city.world.idx(b.x, b.y);
    const name = city.def(b).name;
    city.demolish(b.x, b.y);
    city.pushMessage('Fire!', `A ${name.toLowerCase()} has burned to the ground.`, 'bad', tile);
    // Fire leaves its immediate neighbours dangerous, but does not light them.
    //
    // The wider, harder version of this — a five-by-five splash that pushed every
    // neighbour past the ignition threshold — compounded at better than one new fire
    // per fire and took a district to bare ground inside a year with nothing the player
    // could do about it. A fire should be a crisis you can still answer.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const px = b.x + dx;
        const py = b.y + dy;
        if (!city.world.inBounds(px, py)) continue;
        const n = city.buildingAt(px, py);
        if (n && city.rng.chance(0.25)) n.fire = Math.min(96, n.fire + 40);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Trade
  // -------------------------------------------------------------------------

  setTradePolicy(g: GoodId, p: TradePolicy): void {
    this.tradePolicy[g] = p;
  }

  /** Open a route, charging the one-off cost. */
  openRoute(city: string): boolean {
    const r = this.city.trade.find((t) => t.city === city);
    if (!r || r.open) return false;
    if (this.city.funds < r.cost) return false;
    this.city.funds -= r.cost;
    r.open = true;
    this.city.pushMessage(
      `Trade route to ${city} opened`,
      `Caravans and ships may now travel between your city and ${city}.`,
      'good',
    );
    return true;
  }

  private runTrade(): void {
    const city = this.city;
    const hasPost = city.countOf('trading_post') > 0;
    const hasDock = city.countOf('dock') > 0;
    if (!hasPost && !hasDock) return;

    for (const route of city.trade) {
      if (!route.open) continue;
      if (route.kind === 'land' && !hasPost) continue;
      if (route.kind === 'sea' && !hasDock) continue;

      // Export: sell surplus the partner will buy.
      for (const [gRaw, quotaRaw] of Object.entries(route.buys)) {
        const g = gRaw as GoodId;
        const quota = quotaRaw as number;
        if (this.tradePolicy[g] !== 'export') continue;
        const soldAlready = route.soldThisYear[g] ?? 0;
        if (soldAlready >= quota) continue;

        const keep = this.tradeLimit[g] ?? 0;
        const yard = this.bestYardFor(g);
        if (!yard) continue;
        const available = (yard.store[g] ?? 0) - keep;
        if (available <= 0) continue;

        const qty = Math.min(available, quota - soldAlready, 40);
        if (qty < 1) continue;
        yard.store[g] = (yard.store[g] ?? 0) - qty;
        route.soldThisYear[g] = soldAlready + qty;
        const revenue = Math.round(qty * GOODS[g].value * 0.9);
        city.funds += revenue;
      }

      // Import: buy what we have asked for.
      for (const [gRaw, quotaRaw] of Object.entries(route.sells)) {
        const g = gRaw as GoodId;
        const quota = quotaRaw as number;
        if (this.tradePolicy[g] !== 'import') continue;
        const boughtAlready = route.boughtThisYear[g] ?? 0;
        if (boughtAlready >= quota) continue;

        const yard = this.bestYardFor(g, true);
        if (!yard) continue;
        const def = BUILDING_BY_ID[yard.defId];
        const used = Object.values(yard.store).reduce((a: number, v) => a + (v ?? 0), 0);
        const room = (def.storage ?? 0) - used;
        if (room <= 0) continue;

        const ceiling = this.tradeLimit[g] ?? 200;
        const held = city.totalStored(g);
        if (held >= ceiling) continue;

        const qty = Math.min(room, quota - boughtAlready, 30, ceiling - held);
        if (qty < 1) continue;
        const cost = Math.round(qty * GOODS[g].value * 1.15);
        if (city.funds < cost) continue;
        city.funds -= cost;
        yard.store[g] = (yard.store[g] ?? 0) + qty;
        route.boughtThisYear[g] = boughtAlready + qty;
      }
    }
  }

  private bestYardFor(g: GoodId, wantRoom = false): Building | null {
    const city = this.city;
    const kind = GOODS[g].kind === 'food' ? 'granary' : 'storage_yard';
    let best: Building | null = null;
    let bestScore = -Infinity;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b || b.defId !== kind || !b.built) continue;
      const score = wantRoom
        ? -(Object.values(b.store).reduce((a: number, v) => a + (v ?? 0), 0))
        : b.store[g] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Military
  // -------------------------------------------------------------------------

  private runMilitary(): void {
    const city = this.city;
    const recruiters = city.countOf('recruiter');
    const academy = city.countOf('academy') > 0;

    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b?.garrison) continue;
      const def = city.def(b);
      const gar = b.garrison;

      // Recruits arrive only if a recruiter is working and weapons are available.
      if (gar.strength < gar.maxStrength && recruiters > 0) {
        const needed = def.consumes ? Object.keys(def.consumes)[0] as GoodId : null;
        let can = true;
        if (needed) {
          const yard = this.bestYardFor(needed);
          const have = yard?.store[needed] ?? 0;
          if (have >= 2) {
            yard!.store[needed] = have - 2;
          } else {
            can = false;
          }
        }
        if (can) gar.strength = Math.min(gar.maxStrength, gar.strength + 2);
      }

      if (academy && gar.training < 100) gar.training = Math.min(100, gar.training + 8);
      gar.morale = clamp(gar.morale + (city.godMood.seth > 40 ? 4 : 1), 0, 100);
    }

    // Invasions.
    for (const inv of city.invasions) {
      if (inv.landed) continue;
      if (!inv.warned && city.tick > inv.arrivalTick - TICKS_PER_MONTH * 6) {
        inv.warned = true;
        city.pushMessage(
          'Invasion warning',
          `${inv.enemy} are massing beyond your borders and will arrive within six months. Muster your forts.`,
          'warn',
          inv.entryTile,
        );
      }
      if (city.tick >= inv.arrivalTick) {
        this.landInvasion(inv);
      }
    }
  }

  scheduleInvasion(atTick: number, enemy: string, strength: number): void {
    const city = this.city;
    const w = city.world;
    // Enemies come out of the desert, never the river.
    let entry = -1;
    for (let attempt = 0; attempt < 200 && entry < 0; attempt++) {
      const edge = city.rng.int(4);
      const p = city.rng.range(2, w.size - 3);
      const i =
        edge === 0 ? w.idx(p, 1) :
        edge === 1 ? w.idx(p, w.size - 2) :
        edge === 2 ? w.idx(1, p) : w.idx(w.size - 2, p);
      if (w.terrain[i] !== Terrain.Water) entry = i;
    }
    if (entry < 0) entry = w.idx(1, 1);
    city.invasions.push({
      id: city.invasions.length + 1,
      enemy, strength, arrivalTick: atTick, warned: false, landed: false, entryTile: entry,
    });
  }

  private landInvasion(inv: Invasion): void {
    const city = this.city;
    inv.landed = true;
    const count = clamp(Math.round(inv.strength / 2), 2, 24);
    const w = city.world;
    for (let i = 0; i < count; i++) {
      const ox = city.rng.range(-3, 3);
      const oy = city.rng.range(-3, 3);
      const x = clamp(w.xOf(inv.entryTile) + ox, 1, w.size - 2);
      const y = clamp(w.yOf(inv.entryTile) + oy, 1, w.size - 2);
      city.walkers.spawnEnemy(w.idx(x, y), inv.strength);
    }
    city.pushMessage(
      'We are invaded!',
      `${inv.enemy} have crossed your border in force. Send your companies to meet them or they will burn everything you have built.`,
      'bad',
      inv.entryTile,
    );
  }

  /** Order every fort's company to a tile. */
  rallyTo(x: number, y: number): number {
    const city = this.city;
    let sent = 0;
    for (const id of city.liveBuildings) {
      const b = city.buildings[id];
      if (!b?.garrison || b.garrison.strength <= 0) continue;
      b.garrison.orderTile = city.world.idx(x, y);
      for (let i = 0; i < Math.ceil(b.garrison.strength / 4); i++) {
        if (city.walkers.spawnSoldier(b, x, y)) sent++;
      }
    }
    return sent;
  }

  /** Soldiers and enemies within a tile of each other trade blows. */
  private runCombat(): void {
    const city = this.city;
    if (city.tick % 12 !== 0) return;
    const ws = city.walkers;
    const soldiers: number[] = [];
    const enemies: number[] = [];
    for (const id of ws.live) {
      const w = ws.get(id);
      if (!w) continue;
      if (w.kind === 'soldier') soldiers.push(id);
      else if (w.kind === 'enemy') enemies.push(id);
    }
    if (!soldiers.length || !enemies.length) return;

    for (const sid of soldiers) {
      const s = ws.get(sid);
      if (!s) continue;
      for (const eid of enemies) {
        const e = ws.get(eid);
        if (!e) continue;
        if (Math.abs(s.px - e.px) > 1.5 || Math.abs(s.py - e.py) > 1.5) continue;
        const academy = city.countOf('academy') > 0 ? 1.4 : 1;
        e.hp -= s.attack * academy;
        s.hp -= e.attack * 0.6;
        if (e.hp <= 0) ws.kill(eid);
        if (s.hp <= 0) {
          ws.kill(sid);
          break;
        }
      }
    }

    // All enemies dead? Report the victory once.
    const stillFighting = ws.live.some((id) => ws.get(id)?.kind === 'enemy');
    const pending = city.invasions.some((i) => i.landed && !(i as any).resolved);
    if (!stillFighting && pending) {
      for (const inv of city.invasions) {
        if (inv.landed && !(inv as any).resolved) {
          (inv as any).resolved = true;
          city.ratings.kingdom = clamp(city.ratings.kingdom + 8, 0, 100);
          city.godMood.seth = clamp(city.godMood.seth + 12, -100, 100);
          city.pushMessage(
            'The invaders are driven off',
            `${inv.enemy} have been broken and scattered. Word of your strength will reach the palace.`,
            'good',
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pharaoh's requests
  // -------------------------------------------------------------------------

  addRequest(good: PharaohRequest['good'], amount: number, monthsToDeliver: number, reward = 8, penalty = 10): void {
    const city = this.city;
    city.requests.push({
      id: city.requests.length + 1,
      good, amount,
      dueTick: city.tick + monthsToDeliver * TICKS_PER_MONTH,
      delivered: 0, reward, penalty, resolved: 'pending',
    });
    const what = good === 'deben' ? `${amount} deben` : good === 'troops' ? `${amount} soldiers` : `${amount} ${GOODS[good as GoodId].name.toLowerCase()}`;
    city.pushMessage(
      'A request from Pharaoh',
      `Pharaoh requires ${what} within ${monthsToDeliver} months. Meeting it will raise your standing; failing it will not be forgotten.`,
      'request',
    );
  }

  /** Attempt to fulfil a request from current stores. Returns units actually sent. */
  fulfilRequest(req: PharaohRequest): number {
    const city = this.city;
    if (req.resolved !== 'pending') return 0;
    const want = req.amount - req.delivered;
    if (want <= 0) return 0;

    if (req.good === 'deben') {
      const give = Math.min(want, Math.max(0, city.funds));
      city.funds -= give;
      req.delivered += give;
    } else if (req.good === 'troops') {
      let give = 0;
      for (const id of city.liveBuildings) {
        const b = city.buildings[id];
        if (!b?.garrison) continue;
        const take = Math.min(b.garrison.strength, want - give);
        b.garrison.strength -= take;
        give += take;
        if (give >= want) break;
      }
      req.delivered += give;
    } else {
      const g = req.good as GoodId;
      let give = 0;
      for (const id of city.liveBuildings) {
        const b = city.buildings[id];
        if (!b || (b.defId !== 'granary' && b.defId !== 'storage_yard')) continue;
        const have = b.store[g] ?? 0;
        const take = Math.min(have, want - give);
        b.store[g] = have - take;
        give += take;
        if (give >= want) break;
      }
      req.delivered += give;
    }

    if (req.delivered >= req.amount) {
      req.resolved = 'met';
      city.ratings.kingdom = clamp(city.ratings.kingdom + req.reward, 0, 100);
      city.pushMessage('Request fulfilled', `Pharaoh's request has been met in full. Your standing rises.`, 'good');
    }
    return req.delivered;
  }

  private updateRequests(): void {
    const city = this.city;
    for (const req of city.requests) {
      if (req.resolved !== 'pending') continue;
      if (city.tick > req.dueTick) {
        req.resolved = 'failed';
        city.ratings.kingdom = clamp(city.ratings.kingdom - req.penalty, 0, 100);
        city.pushMessage(
          'Request unmet',
          `You have failed to meet Pharaoh's request. Your standing at court has suffered.`,
          'bad',
        );
      }
    }
  }
}
