/**
 * The campaign.
 *
 * Ten missions running from a predynastic village on the riverbank to a New Kingdom
 * capital. Each one introduces one new idea and then demands that you hold it together
 * while the previous ones keep running — which is the whole shape of this genre.
 */

import type { GoodId } from './data';
import type { TradeRoute } from './sim';

export interface MissionGoals {
  population?: number;
  culture?: number;
  prosperity?: number;
  monument?: number;
  kingdom?: number;
  /** Monument building ids that must be completed. */
  monuments?: string[];
  /** Survive to at least this year of the mission. */
  years?: number;
}

export interface MissionInvasion {
  /** Mission year the attack lands. */
  year: number;
  enemy: string;
  strength: number;
}

export interface MissionRequest {
  year: number;
  good: GoodId | 'troops' | 'deben';
  amount: number;
  months: number;
}

export interface Mission {
  id: string;
  name: string;
  place: string;
  era: string;
  brief: string;
  hint: string;

  mapSeed: number;
  mapSize: number;
  riverWidth: number;
  floodplainWidth: number;
  rockiness: number;

  startFunds: number;
  taxRate: number;
  /** Building ids available. Empty means everything. */
  unlocks: string[];

  goals: MissionGoals;
  routes: Omit<TradeRoute, 'soldThisYear' | 'boughtThisYear'>[];
  invasions: MissionInvasion[];
  requests: MissionRequest[];
}

const route = (
  city: string,
  kind: 'land' | 'sea',
  cost: number,
  sells: Partial<Record<GoodId, number>>,
  buys: Partial<Record<GoodId, number>>,
  open = false,
): Omit<TradeRoute, 'soldThisYear' | 'boughtThisYear'> => ({ city, kind, open, cost, sells, buys });

/** Everything a starter village can build. */
const BASIC = [
  'road', 'house', 'well', 'farm_grain', 'farm_chickpea', 'farm_lettuce', 'work_camp',
  'granary', 'bazaar', 'storage_yard',
  'clay_pit', 'potter', 'firehouse', 'architect_post', 'tax_collector', 'garden',
  'shrine_osiris', 'shrine_ra', 'temple_osiris', 'temple_ra', 'booth', 'juggler_school',
  'reed_gatherer', 'fishing_wharf', 'hunting_lodge', 'roadblock',
];

const TRADE_TIER = [
  ...BASIC, 'trading_post', 'dock', 'water_supply', 'scribal_school', 'apothecary',
  'farm_flax', 'farm_barley', 'farm_fig', 'farm_pomegranate', 'cattle_ranch',
  'weaver', 'brewery', 'timber_yard', 'copper_mine', 'quarry_plainstone', 'quarry_limestone',
  'brickworks', 'temple_ptah', 'shrine_ptah', 'plaza', 'statue_sm', 'courthouse',
];

const MONUMENT_TIER = [
  ...TRADE_TIER, 'bricklayer_guild', 'stonemason_guild', 'carpenter_guild',
  'mon_mastaba', 'bandstand', 'conservatory', 'library', 'physician', 'mortuary',
  'quarry_sandstone', 'papyrus_maker', 'oracle', 'festival_square', 'mansion',
];

const FULL: string[] = []; // empty = no restriction

export const MISSIONS: Mission[] = [
  {
    id: 'nubt',
    name: 'A Village on the Black Land',
    place: 'Nubt',
    era: 'Predynastic, c. 3500 BC',
    brief:
      'You have been given a bend of the river and told to make something of it. Lay roads, ' +
      'mark out housing, dig a well, and put barley in the ground before the flood returns.',
    hint:
      'Everything in this city moves on foot. A building only works if a road connects it ' +
      'to the people who need it — start with a compact loop, not a sprawl.',
    mapSeed: 1337, mapSize: 80, riverWidth: 7, floodplainWidth: 14, rockiness: 0.6,
    startFunds: 1800, taxRate: 0.08,
    unlocks: BASIC,
    goals: { population: 450, culture: 8, prosperity: 10 },
    routes: [route('Nekhen', 'land', 0, { pottery: 120 }, { grain: 200 }, true)],
    invasions: [],
    requests: [{ year: 4, good: 'grain', amount: 120, months: 12 }],
  },
  {
    id: 'timna',
    name: 'Copper from the Red Land',
    place: 'Timna',
    era: 'Early Dynastic, c. 3000 BC',
    brief:
      'The desert here hides copper, and Egypt is hungry for it. Mine the hills, work the ' +
      'metal, and open a trade route that will pay for everything you build next.',
    hint:
      'Mines need a road all the way back to a storage yard. Watch your labour priorities — ' +
      'industry will starve if food is set above it and your farms are still growing.',
    mapSeed: 8802, mapSize: 88, riverWidth: 6, floodplainWidth: 11, rockiness: 1.5,
    startFunds: 2400, taxRate: 0.09,
    unlocks: TRADE_TIER,
    goals: { population: 900, prosperity: 24, culture: 16 },
    routes: [
      route('Nekhen', 'land', 0, { grain: 200 }, { copper: 150, pottery: 120 }, true),
      route('Byblos', 'sea', 600, { timber: 180 }, { copper: 200, linen: 100 }),
    ],
    invasions: [{ year: 8, enemy: 'Bedouin raiders', strength: 6 }],
    requests: [{ year: 5, good: 'copper', amount: 90, months: 14 }],
  },
  {
    id: 'perwer',
    name: 'A House for Eternity',
    place: 'Per-Wer',
    era: 'First Dynasty, c. 2900 BC',
    brief:
      'The nomarch wants a tomb worthy of his name. Raise a mastaba of mud brick and dressed ' +
      'limestone — and keep the city fed while a quarter of your workforce is on the site.',
    hint:
      'Monuments consume labour you would otherwise spend on food and industry. Build the ' +
      'work camps and guilds early, then raise the labour priority of Monuments only when ' +
      'your granaries are full.',
    mapSeed: 4519, mapSize: 92, riverWidth: 8, floodplainWidth: 15, rockiness: 1.2,
    startFunds: 3000, taxRate: 0.09,
    unlocks: MONUMENT_TIER,
    goals: { population: 1200, monuments: ['mon_mastaba'], culture: 24, prosperity: 28 },
    routes: [
      route('Nekhen', 'land', 0, { grain: 240 }, { pottery: 160, beer: 120 }, true),
      route('Byblos', 'sea', 500, { timber: 200 }, { linen: 140 }),
    ],
    invasions: [],
    requests: [{ year: 6, good: 'bricks', amount: 100, months: 12 }],
  },
  {
    id: 'nekhen',
    name: 'The Stairway to Heaven',
    place: 'Nekhen',
    era: 'Third Dynasty, c. 2650 BC',
    brief:
      'Imhotep has shown that a tomb may be stacked upon a tomb until it reaches the sky. ' +
      'Build a step pyramid, and build the priesthood that will justify it.',
    hint:
      'Three gods want temples now, not one. A neglected god is not a small problem — ' +
      'Osiris controls your flood, and a failed inundation will empty your granaries.',
    mapSeed: 7731, mapSize: 96, riverWidth: 8, floodplainWidth: 16, rockiness: 1.6,
    startFunds: 3600, taxRate: 0.10,
    unlocks: [...MONUMENT_TIER, 'mon_step_pyramid', 'temple_bast', 'shrine_bast', 'dentist', 'pavilion', 'dance_school', 'senet_house'],
    goals: { population: 1800, monuments: ['mon_step_pyramid'], culture: 35, prosperity: 34, kingdom: 55 },
    routes: [
      route('Buto', 'sea', 0, { fish: 200 }, { pottery: 180, papyrus: 120 }, true),
      route('Byblos', 'sea', 600, { timber: 240 }, { linen: 160, beer: 140 }),
      route('Punt', 'sea', 1400, { gems: 90 }, { grain: 260, linen: 120 }),
    ],
    invasions: [{ year: 12, enemy: 'Libyan tribes', strength: 10 }],
    requests: [
      { year: 5, good: 'linen', amount: 80, months: 12 },
      { year: 14, good: 'deben', amount: 900, months: 10 },
    ],
  },
  {
    id: 'buto',
    name: 'The Delta Will Not Hold Itself',
    place: 'Buto',
    era: 'Old Kingdom, c. 2500 BC',
    brief:
      'The marshes are rich and badly defended. Raise forts, arm them, and hold the northern ' +
      'border while the delta pays for itself in papyrus and flax.',
    hint:
      'Forts need weapons, weapons need copper, and a recruiter needs housed young men. ' +
      'A fort with no company inside it is a very expensive building.',
    mapSeed: 2244, mapSize: 96, riverWidth: 11, floodplainWidth: 20, rockiness: 0.5,
    startFunds: 4200, taxRate: 0.10,
    unlocks: [...MONUMENT_TIER, 'recruiter', 'fort_infantry', 'fort_archers', 'academy', 'wall', 'tower', 'gatehouse', 'weaponsmith', 'temple_seth', 'shrine_seth', 'temple_bast', 'shrine_bast', 'dentist', 'pavilion', 'dance_school'],
    goals: { population: 2200, culture: 40, prosperity: 38, kingdom: 60, years: 16 },
    routes: [
      route('Byblos', 'sea', 0, { timber: 300, copper: 180 }, { papyrus: 200, linen: 180 }, true),
      route('Kush', 'land', 900, { gold: 100 }, { grain: 300, beer: 180 }),
    ],
    invasions: [
      { year: 5, enemy: 'Libyan tribes', strength: 10 },
      { year: 10, enemy: 'Sea raiders', strength: 16 },
      { year: 15, enemy: 'A Hyksos war band', strength: 24 },
    ],
    requests: [
      { year: 7, good: 'weapons', amount: 60, months: 12 },
      { year: 12, good: 'troops', amount: 20, months: 10 },
    ],
  },
  {
    id: 'memphis',
    name: 'The Great Pyramid',
    place: 'Memphis',
    era: 'Fourth Dynasty, c. 2560 BC',
    brief:
      'A true pyramid, faced in white limestone, on the plateau above the river. It will take ' +
      'most of your working life and every quarry you can open. Begin.',
    hint:
      'Five stages, thousands of units of stone, and a city that still has to eat. Open a ' +
      'granite route early — the burial chamber will stop the whole project without it.',
    mapSeed: 9110, mapSize: 104, riverWidth: 10, floodplainWidth: 18, rockiness: 2.0,
    startFunds: 5000, taxRate: 0.10,
    unlocks: [...MONUMENT_TIER, 'mon_pyramid', 'mon_sphinx', 'quarry_granite', 'gold_mine', 'gem_mine', 'jeweler', 'artisan_guild', 'temple_seth', 'temple_bast', 'shrine_seth', 'shrine_bast', 'dentist', 'pavilion', 'dance_school', 'senet_house', 'recruiter', 'fort_infantry', 'weaponsmith', 'statue_lg'],
    goals: { population: 3000, monuments: ['mon_pyramid'], monument: 60, prosperity: 45, culture: 45 },
    routes: [
      route('Byblos', 'sea', 0, { timber: 400 }, { pottery: 240, linen: 200 }, true),
      route('Aswan', 'sea', 1200, { granite: 240, gold: 120 }, { grain: 400, beer: 240 }),
      route('Kush', 'land', 1000, { gold: 160, gems: 100 }, { linen: 200, pottery: 200 }),
    ],
    invasions: [{ year: 18, enemy: 'Nubian raiders', strength: 18 }],
    requests: [
      { year: 6, good: 'limestone', amount: 150, months: 14 },
      { year: 15, good: 'deben', amount: 1600, months: 12 },
    ],
  },
  {
    id: 'iunu',
    name: 'The House of Ra',
    place: 'Iunu',
    era: 'Fifth Dynasty, c. 2450 BC',
    brief:
      'Ra is now the first god of Egypt, and Iunu is his city. Build him a sun temple with an ' +
      'open court, and make the city learned enough to deserve it.',
    hint:
      'Libraries consume papyrus continuously. A library with an empty store teaches nobody, ' +
      'and half your housing will stall one rung short of a residence.',
    mapSeed: 6060, mapSize: 100, riverWidth: 9, floodplainWidth: 17, rockiness: 1.4,
    startFunds: 5200, taxRate: 0.10,
    unlocks: [...MONUMENT_TIER, 'mon_sun_temple', 'mon_obelisk', 'quarry_granite', 'gold_mine', 'jeweler', 'artisan_guild', 'gem_mine', 'temple_seth', 'temple_bast', 'shrine_seth', 'shrine_bast', 'complex_ra', 'dentist', 'pavilion', 'dance_school', 'senet_house', 'statue_lg', 'recruiter', 'fort_archers', 'weaponsmith'],
    goals: { population: 3500, monuments: ['mon_sun_temple'], culture: 58, prosperity: 50, kingdom: 62 },
    routes: [
      route('Byblos', 'sea', 0, { timber: 400 }, { papyrus: 300, luxury: 90 }, true),
      route('Aswan', 'sea', 1000, { granite: 260 }, { grain: 400 }),
      route('Punt', 'sea', 1800, { gems: 140 }, { linen: 260, papyrus: 220 }),
    ],
    invasions: [{ year: 14, enemy: 'Desert nomads', strength: 14 }],
    requests: [{ year: 8, good: 'papyrus', amount: 120, months: 12 }],
  },
  {
    id: 'abydos',
    name: 'Lord of the Silent Land',
    place: 'Abydos',
    era: 'Middle Kingdom, c. 1950 BC',
    brief:
      'Every Egyptian who can afford it wants to be buried within sight of Osiris. Build his ' +
      'temple complex, hold the festivals, and make Abydos the most desirable city in Egypt.',
    hint:
      'A temple complex is enormous and its priests roam far. Put it at the heart of your ' +
      'housing, not on the edge, and hold festivals before the god has a chance to sour.',
    mapSeed: 3388, mapSize: 100, riverWidth: 9, floodplainWidth: 18, rockiness: 1.3,
    startFunds: 5600, taxRate: 0.11,
    unlocks: FULL,
    goals: { population: 4200, culture: 68, prosperity: 58, kingdom: 70, monument: 40 },
    routes: [
      route('Thebes', 'land', 0, { granite: 240, gold: 140 }, { linen: 300, beer: 280 }, true),
      route('Byblos', 'sea', 900, { timber: 400 }, { papyrus: 300, luxury: 120 }),
      route('Punt', 'sea', 1800, { gems: 160 }, { chariots: 40, luxury: 100 }),
    ],
    invasions: [{ year: 11, enemy: 'Nubian raiders', strength: 20 }],
    requests: [
      { year: 6, good: 'luxury', amount: 60, months: 12 },
      { year: 13, good: 'deben', amount: 2000, months: 12 },
    ],
  },
  {
    id: 'thebes',
    name: 'The Sceptre of the South',
    place: 'Waset',
    era: 'New Kingdom, c. 1450 BC',
    brief:
      'Thebes is the richest city in the world and Pharaoh expects it to look like it. Raise ' +
      'an obelisk of Aswan granite, keep the whole pantheon content, and pay for all of it.',
    hint:
      'This is an economy mission wearing a monument as a hat. Export chariots and luxury ' +
      'goods; nothing else generates money on the scale you now need.',
    mapSeed: 5150, mapSize: 108, riverWidth: 10, floodplainWidth: 19, rockiness: 1.8,
    startFunds: 6000, taxRate: 0.11,
    unlocks: FULL,
    goals: { population: 5000, monuments: ['mon_obelisk'], culture: 72, prosperity: 68, kingdom: 72 },
    routes: [
      route('Aswan', 'sea', 0, { granite: 320, gold: 200 }, { grain: 500, beer: 320 }, true),
      route('Byblos', 'sea', 1000, { timber: 500, copper: 260 }, { chariots: 60, luxury: 140 }),
      route('Kush', 'land', 1400, { gold: 220, gems: 180 }, { linen: 320, pottery: 300 }),
      route('Mitanni', 'land', 2200, { copper: 300 }, { chariots: 80, weapons: 160 }),
    ],
    invasions: [
      { year: 9, enemy: 'Nubian rebels', strength: 22 },
      { year: 17, enemy: 'A Hittite column', strength: 32 },
    ],
    requests: [
      { year: 5, good: 'chariots', amount: 30, months: 12 },
      { year: 12, good: 'troops', amount: 30, months: 10 },
      { year: 18, good: 'gold', amount: 100, months: 12 },
    ],
  },
  {
    id: 'piramesses',
    name: 'The City of Ramesses',
    place: 'Pi-Ramesses',
    era: 'New Kingdom, c. 1270 BC',
    brief:
      'A new capital in the delta, built from nothing, on the frontier, in wartime. Everything ' +
      'you have learned, all at once, with the Hittites at the gate.',
    hint:
      'There is no single trick left. Districts must be planned, roadblocks must steer your ' +
      'walkers, and the army must be paid for by an economy you have not finished building.',
    mapSeed: 1210, mapSize: 112, riverWidth: 12, floodplainWidth: 22, rockiness: 1.0,
    startFunds: 7000, taxRate: 0.12,
    unlocks: FULL,
    goals: {
      population: 6500, monuments: ['mon_pyramid', 'mon_sphinx'],
      culture: 80, prosperity: 78, kingdom: 80, monument: 80,
    },
    routes: [
      route('Byblos', 'sea', 0, { timber: 500, copper: 300 }, { chariots: 80, weapons: 200 }, true),
      route('Aswan', 'sea', 1200, { granite: 360, gold: 220 }, { grain: 600 }),
      route('Punt', 'sea', 2000, { gems: 200 }, { luxury: 180, linen: 360 }),
      route('Mitanni', 'land', 2400, { copper: 340 }, { chariots: 100 }),
      route('Kush', 'land', 1600, { gold: 260 }, { pottery: 400, beer: 360 }),
    ],
    invasions: [
      { year: 4, enemy: 'Libyan raiders', strength: 18 },
      { year: 9, enemy: 'Sea Peoples', strength: 28 },
      { year: 14, enemy: 'A Hittite army', strength: 40 },
      { year: 19, enemy: 'The Hittite king himself', strength: 52 },
    ],
    requests: [
      { year: 4, good: 'weapons', amount: 100, months: 10 },
      { year: 8, good: 'troops', amount: 40, months: 10 },
      { year: 13, good: 'deben', amount: 3000, months: 12 },
      { year: 17, good: 'chariots', amount: 50, months: 12 },
    ],
  },
];

export const SANDBOX: Mission = {
  id: 'sandbox',
  name: 'Sandbox',
  place: 'A river of your own',
  era: 'Any age you like',
  brief: 'No objectives, no invasions, no requests. Build for the pleasure of building.',
  hint: 'Everything is unlocked and the treasury is generous. Try things you would not risk in a campaign.',
  mapSeed: 24601, mapSize: 104, riverWidth: 10, floodplainWidth: 18, rockiness: 1.4,
  startFunds: 40000, taxRate: 0.09,
  unlocks: FULL,
  goals: {},
  routes: [
    route('Byblos', 'sea', 0, { timber: 999, copper: 999 }, { pottery: 999, linen: 999, chariots: 999 }, true),
    route('Aswan', 'sea', 0, { granite: 999, gold: 999, gems: 999 }, { grain: 999, beer: 999 }, true),
    route('Punt', 'sea', 0, { gems: 999 }, { luxury: 999, papyrus: 999 }, true),
  ],
  invasions: [],
  requests: [],
};

export const ALL_MISSIONS = [...MISSIONS, SANDBOX];

export function missionById(id: string): Mission {
  return ALL_MISSIONS.find((m) => m.id === id) ?? MISSIONS[0];
}
