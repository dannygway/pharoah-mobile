/**
 * Static game data: goods, the housing ladder, gods, and the building catalogue.
 *
 * Nothing here mutates at runtime. The simulation reads these tables and keeps its
 * own mutable instance state, which keeps saves small and makes balance tweaks safe.
 */

// ---------------------------------------------------------------------------
// Goods
// ---------------------------------------------------------------------------

export type GoodId =
  // foods
  | 'grain' | 'vegetables' | 'fruit' | 'meat' | 'fish'
  // raw materials
  | 'clay' | 'reeds' | 'straw' | 'flax' | 'timber' | 'copper' | 'gold' | 'gems'
  | 'limestone' | 'sandstone' | 'granite' | 'bricks'
  // manufactured
  | 'pottery' | 'linen' | 'beer' | 'papyrus' | 'luxury' | 'weapons' | 'chariots';

export interface GoodDef {
  id: GoodId;
  name: string;
  kind: 'food' | 'raw' | 'good';
  /** Base market value in deben, used for trade pricing. */
  value: number;
  /** Short glyph used in dense UI rows. */
  glyph: string;
  color: string;
}

export const GOODS: Record<GoodId, GoodDef> = {
  grain:      { id: 'grain',      name: 'Grain',      kind: 'food', value: 28,  glyph: '🌾', color: '#d8b24a' },
  vegetables: { id: 'vegetables', name: 'Vegetables', kind: 'food', value: 24,  glyph: '🫒', color: '#7fa84c' },
  fruit:      { id: 'fruit',      name: 'Fruit',      kind: 'food', value: 26,  glyph: '🍇', color: '#b0496b' },
  meat:       { id: 'meat',       name: 'Meat',       kind: 'food', value: 32,  glyph: '🥩', color: '#a4553f' },
  fish:       { id: 'fish',       name: 'Fish',       kind: 'food', value: 26,  glyph: '🐟', color: '#5b93a8' },

  clay:       { id: 'clay',       name: 'Clay',       kind: 'raw',  value: 18,  glyph: '🟤', color: '#8a5a3b' },
  reeds:      { id: 'reeds',      name: 'Reeds',      kind: 'raw',  value: 16,  glyph: '🌿', color: '#6f8a45' },
  straw:      { id: 'straw',      name: 'Straw',      kind: 'raw',  value: 12,  glyph: '🌾', color: '#c9ae63' },
  flax:       { id: 'flax',       name: 'Flax',       kind: 'raw',  value: 22,  glyph: '🌱', color: '#9db56b' },
  timber:     { id: 'timber',     name: 'Timber',     kind: 'raw',  value: 34,  glyph: '🪵', color: '#7a5433' },
  copper:     { id: 'copper',     name: 'Copper',     kind: 'raw',  value: 46,  glyph: '🟠', color: '#b5713c' },
  gold:       { id: 'gold',       name: 'Gold',       kind: 'raw',  value: 90,  glyph: '🟡', color: '#e0b437' },
  gems:       { id: 'gems',       name: 'Gems',       kind: 'raw',  value: 110, glyph: '💎', color: '#59a5c4' },
  limestone:  { id: 'limestone',  name: 'Limestone',  kind: 'raw',  value: 40,  glyph: '⬜', color: '#cdc3a8' },
  sandstone:  { id: 'sandstone',  name: 'Sandstone',  kind: 'raw',  value: 42,  glyph: '🟨', color: '#c9a172' },
  granite:    { id: 'granite',    name: 'Granite',    kind: 'raw',  value: 58,  glyph: '⬛', color: '#8d7f76' },
  bricks:     { id: 'bricks',     name: 'Bricks',     kind: 'raw',  value: 30,  glyph: '🧱', color: '#9c6a45' },

  pottery:    { id: 'pottery',    name: 'Pottery',    kind: 'good', value: 40,  glyph: '🏺', color: '#b3653f' },
  linen:      { id: 'linen',      name: 'Linen',      kind: 'good', value: 54,  glyph: '🧵', color: '#e2ddcc' },
  beer:       { id: 'beer',       name: 'Beer',       kind: 'good', value: 48,  glyph: '🍺', color: '#c99a3e' },
  papyrus:    { id: 'papyrus',    name: 'Papyrus',    kind: 'good', value: 50,  glyph: '📜', color: '#ded2a6' },
  luxury:     { id: 'luxury',     name: 'Luxury Goods', kind: 'good', value: 120, glyph: '💍', color: '#dcc04a' },
  weapons:    { id: 'weapons',    name: 'Weapons',    kind: 'good', value: 100, glyph: '⚔️', color: '#9aa2a8' },
  chariots:   { id: 'chariots',   name: 'Chariots',   kind: 'good', value: 160, glyph: '🛞', color: '#8a6a44' },
};

export const FOOD_IDS: GoodId[] = ['grain', 'vegetables', 'fruit', 'meat', 'fish'];
/** Goods a household consumes, in the order houses come to want them. */
export const HOUSEHOLD_GOODS: GoodId[] = ['pottery', 'linen', 'beer', 'luxury'];
export const ALL_GOOD_IDS = Object.keys(GOODS) as GoodId[];

// ---------------------------------------------------------------------------
// Gods
// ---------------------------------------------------------------------------

export type GodId = 'osiris' | 'ra' | 'ptah' | 'seth' | 'bast';

export interface GodDef {
  id: GodId;
  name: string;
  domain: string;
  /** What a pleased god does for you. */
  blessing: string;
  /** What an angry god does to you. */
  wrath: string;
  color: string;
  glyph: string;
}

export const GODS: Record<GodId, GodDef> = {
  osiris: {
    id: 'osiris', name: 'Osiris', domain: 'The Nile & the afterlife',
    blessing: 'Grants a bountiful inundation, enriching the floodplain.',
    wrath: 'Withholds the flood, leaving the fields barren.',
    color: '#3f9d7a', glyph: '🌊',
  },
  ra: {
    id: 'ra', name: 'Ra', domain: 'The sun & kingship',
    blessing: 'Ripens the harvest and fills your granaries.',
    wrath: 'Scorches the crops and sets fire to the city.',
    color: '#e0a832', glyph: '☀️',
  },
  ptah: {
    id: 'ptah', name: 'Ptah', domain: 'Craft & industry',
    blessing: 'Fills your storage yards with finished goods.',
    wrath: 'Destroys workshops and spoils raw materials.',
    color: '#5a8fc4', glyph: '🏺',
  },
  seth: {
    id: 'seth', name: 'Seth', domain: 'War, storms & the desert',
    blessing: 'Strengthens your troops and scatters invaders.',
    wrath: 'Summons enemies and sinks your trading ships.',
    color: '#b4553f', glyph: '⚡',
  },
  bast: {
    id: 'bast', name: 'Bast', domain: 'Health, joy & the home',
    blessing: 'Wards off plague and lifts the spirits of the people.',
    wrath: 'Looses disease upon your streets.',
    color: '#b07fc0', glyph: '🐈',
  },
};
export const GOD_IDS: GodId[] = ['osiris', 'ra', 'ptah', 'seth', 'bast'];

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** Every service a roaming walker can deliver to a house. */
export type ServiceId =
  | 'water' | 'wellWater'
  | 'religionOsiris' | 'religionRa' | 'religionPtah' | 'religionSeth' | 'religionBast'
  | 'school' | 'library'
  | 'booth' | 'bandstand' | 'pavilion' | 'senet'
  | 'apothecary' | 'physician' | 'dentist' | 'mortuary'
  | 'tax' | 'fire' | 'architect' | 'magistrate';

export const RELIGION_SERVICE: Record<GodId, ServiceId> = {
  osiris: 'religionOsiris',
  ra: 'religionRa',
  ptah: 'religionPtah',
  seth: 'religionSeth',
  bast: 'religionBast',
};

// ---------------------------------------------------------------------------
// Housing ladder
// ---------------------------------------------------------------------------

export interface HousingLevel {
  level: number;
  name: string;
  /** People housed per house tile at this level. */
  capacity: number;
  /** Minimum desirability to evolve to this level. */
  desirability: number;
  /** Maximum desirability before the house feels out of place and devolves. */
  desirabilityMax: number;
  /** 0 = none, 1 = well, 2 = water supply. */
  water: 0 | 1 | 2;
  /** Distinct food types required in the house. */
  foodTypes: number;
  /** Number of different gods that must have visited. */
  gods: number;
  /** Household goods required, as a prefix of HOUSEHOLD_GOODS. */
  goods: number;
  education: 0 | 1 | 2 | 3; // 0 none, 1 school, 2 library, 3 both
  entertainment: 0 | 1 | 2 | 3 | 4; // booth, bandstand, pavilion, senet
  health: 0 | 1 | 2 | 3 | 4; // apothecary, physician, dentist, mortuary
  /** Monthly tax yield per person at this level. */
  taxPerPerson: number;
  /** Contribution to the Prosperity rating. */
  prosperity: number;
}

/**
 * The twenty-rung ladder. Requirements ratchet in the classic order: shelter, then
 * water, then a second food, pottery, a god, education, entertainment, medicine,
 * and finally the luxuries that only a great city can supply.
 */
export const HOUSING: HousingLevel[] = [
  { level: 0,  name: 'Empty Lot',          capacity: 0,  desirability: -99, desirabilityMax: 999, water: 0, foodTypes: 0, gods: 0, goods: 0, education: 0, entertainment: 0, health: 0, taxPerPerson: 0,    prosperity: 0 },
  { level: 1,  name: 'Crude Hut',          capacity: 5,  desirability: -20, desirabilityMax: 12,  water: 0, foodTypes: 0, gods: 0, goods: 0, education: 0, entertainment: 0, health: 0, taxPerPerson: 0.10, prosperity: 0 },
  { level: 2,  name: 'Sturdy Hut',         capacity: 7,  desirability: -14, desirabilityMax: 18,  water: 0, foodTypes: 1, gods: 0, goods: 0, education: 0, entertainment: 0, health: 0, taxPerPerson: 0.14, prosperity: 2 },
  { level: 3,  name: 'Meager Shanty',      capacity: 9,  desirability: -10, desirabilityMax: 24,  water: 1, foodTypes: 1, gods: 0, goods: 0, education: 0, entertainment: 0, health: 0, taxPerPerson: 0.18, prosperity: 5 },
  { level: 4,  name: 'Common Shanty',      capacity: 11, desirability: -6,  desirabilityMax: 30,  water: 1, foodTypes: 1, gods: 1, goods: 0, education: 0, entertainment: 0, health: 0, taxPerPerson: 0.22, prosperity: 8 },
  { level: 5,  name: 'Rough Cottage',      capacity: 13, desirability: -2,  desirabilityMax: 36,  water: 1, foodTypes: 1, gods: 1, goods: 1, education: 0, entertainment: 0, health: 0, taxPerPerson: 0.28, prosperity: 11 },
  { level: 6,  name: 'Ordinary Cottage',   capacity: 15, desirability: 2,   desirabilityMax: 42,  water: 1, foodTypes: 2, gods: 1, goods: 1, education: 1, entertainment: 0, health: 0, taxPerPerson: 0.34, prosperity: 14 },
  { level: 7,  name: 'Modest Homestead',   capacity: 17, desirability: 6,   desirabilityMax: 48,  water: 1, foodTypes: 2, gods: 1, goods: 1, education: 1, entertainment: 1, health: 0, taxPerPerson: 0.42, prosperity: 18 },
  { level: 8,  name: 'Spacious Homestead', capacity: 19, desirability: 10,  desirabilityMax: 54,  water: 2, foodTypes: 2, gods: 2, goods: 1, education: 1, entertainment: 1, health: 1, taxPerPerson: 0.50, prosperity: 22 },
  { level: 9,  name: 'Modest Apartment',   capacity: 21, desirability: 14,  desirabilityMax: 60,  water: 2, foodTypes: 2, gods: 2, goods: 2, education: 1, entertainment: 1, health: 1, taxPerPerson: 0.60, prosperity: 26 },
  { level: 10, name: 'Spacious Apartment', capacity: 23, desirability: 18,  desirabilityMax: 66,  water: 2, foodTypes: 2, gods: 2, goods: 2, education: 2, entertainment: 2, health: 1, taxPerPerson: 0.70, prosperity: 31 },
  { level: 11, name: 'Common Residence',   capacity: 26, desirability: 22,  desirabilityMax: 72,  water: 2, foodTypes: 3, gods: 3, goods: 2, education: 2, entertainment: 2, health: 2, taxPerPerson: 0.82, prosperity: 36 },
  { level: 12, name: 'Spacious Residence', capacity: 29, desirability: 26,  desirabilityMax: 78,  water: 2, foodTypes: 3, gods: 3, goods: 3, education: 2, entertainment: 2, health: 2, taxPerPerson: 0.95, prosperity: 42 },
  { level: 13, name: 'Elegant Residence',  capacity: 32, desirability: 31,  desirabilityMax: 84,  water: 2, foodTypes: 3, gods: 3, goods: 3, education: 3, entertainment: 3, health: 2, taxPerPerson: 1.10, prosperity: 48 },
  { level: 14, name: 'Fancy Residence',    capacity: 35, desirability: 36,  desirabilityMax: 90,  water: 2, foodTypes: 3, gods: 4, goods: 3, education: 3, entertainment: 3, health: 3, taxPerPerson: 1.28, prosperity: 55 },
  { level: 15, name: 'Common Manor',       capacity: 38, desirability: 42,  desirabilityMax: 96,  water: 2, foodTypes: 3, gods: 4, goods: 4, education: 3, entertainment: 3, health: 3, taxPerPerson: 1.48, prosperity: 62 },
  { level: 16, name: 'Spacious Manor',     capacity: 41, desirability: 48,  desirabilityMax: 999, water: 2, foodTypes: 3, gods: 4, goods: 4, education: 3, entertainment: 4, health: 3, taxPerPerson: 1.70, prosperity: 70 },
  { level: 17, name: 'Elegant Manor',      capacity: 44, desirability: 54,  desirabilityMax: 999, water: 2, foodTypes: 3, gods: 5, goods: 4, education: 3, entertainment: 4, health: 4, taxPerPerson: 1.95, prosperity: 79 },
  { level: 18, name: 'Stately Manor',      capacity: 47, desirability: 61,  desirabilityMax: 999, water: 2, foodTypes: 3, gods: 5, goods: 4, education: 3, entertainment: 4, health: 4, taxPerPerson: 2.25, prosperity: 88 },
  { level: 19, name: 'Modest Estate',      capacity: 50, desirability: 68,  desirabilityMax: 999, water: 2, foodTypes: 3, gods: 5, goods: 4, education: 3, entertainment: 4, health: 4, taxPerPerson: 2.60, prosperity: 96 },
  { level: 20, name: 'Palatial Estate',    capacity: 54, desirability: 76,  desirabilityMax: 999, water: 2, foodTypes: 3, gods: 5, goods: 4, education: 3, entertainment: 4, health: 4, taxPerPerson: 3.00, prosperity: 105 },
];

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export type BuildCategory =
  | 'infrastructure' | 'housing' | 'water' | 'food' | 'industry' | 'distribution'
  | 'religion' | 'culture' | 'government' | 'military' | 'monument' | 'trade';

export type LaborSector =
  | 'food' | 'industry' | 'distribution' | 'culture' | 'religion' | 'education'
  | 'health' | 'government' | 'military' | 'infrastructure' | 'monument' | 'trade';

/** How the art generator should draw this building. */
export type ArtStyle =
  | 'mud' | 'stone' | 'reed' | 'farm' | 'mine' | 'water' | 'garden' | 'monument'
  | 'temple' | 'tower' | 'road' | 'house';

export interface BuildingDef {
  id: string;
  name: string;
  cat: BuildCategory;
  /** Footprint in tiles (square). */
  size: number;
  cost: number;
  /** Deben per month while operating. */
  upkeep: number;
  workers: number;
  sector?: LaborSector;
  desc: string;

  /** Desirability emitted: value at the building, falling by `step` every `stepRange` tiles. */
  desirability?: { value: number; range: number; step: number };

  /** Service this building's roaming walker delivers. */
  service?: ServiceId;
  /** Extra services delivered by the same walker (e.g. a temple complex). */
  services?: ServiceId[];
  /**
   * Radius in tiles over which this building serves houses directly, with no walker.
   * Wells work this way: you dig one and the neighbouring houses draw from it.
   */
  directRange?: number;
  /** How many road tiles the roaming walker will cover before turning home. */
  walkerRange?: number;
  /** Ticks between walker despatches. */
  walkerInterval?: number;

  /** Goods consumed per production cycle. */
  consumes?: Partial<Record<GoodId, number>>;
  /** Good produced per cycle. */
  produces?: GoodId;
  /** Units produced per completed cycle. */
  produceQty?: number;
  /** Ticks per production cycle at full staffing. */
  cycleTicks?: number;

  /** Storage capacity in units (granary / storage yard). */
  storage?: number;

  fireRisk?: number;
  damageRisk?: number;
  /** Chance per month of breeding disease (marsh-adjacent industry, etc.). */
  diseaseRisk?: number;

  /** Terrain the building must sit on. */
  terrain?: 'any' | 'floodplain' | 'water-adjacent' | 'rock' | 'dry' | 'marsh';
  /** Must touch a road tile to function. */
  needsRoad?: boolean;

  /** Religion: which god this building honours. */
  god?: GodId;

  /** Monument staging (see sim/monuments). */
  monument?: {
    stages: { name: string; materials: Partial<Record<GoodId, number>>; labor: number }[];
    /** Monument rating points awarded on completion. */
    points: number;
  };

  /** Military */
  garrison?: number;
  troopType?: 'infantry' | 'archers' | 'charioteers';

  art: { style: ArtStyle; base: string; roof: string; accent?: string; height: number };
}

const D = (value: number, range: number, step = 1) => ({ value, range, step });

export const BUILDINGS: BuildingDef[] = [
  // ---------------- Infrastructure ----------------
  {
    id: 'road', name: 'Road', cat: 'infrastructure', size: 1, cost: 4, upkeep: 0, workers: 0,
    desc: 'Beaten earth. Every walker in your city travels by road — service, trade and soldiers alike.',
    art: { style: 'road', base: '#a58a5d', roof: '#a58a5d', height: 0 },
  },
  {
    id: 'plaza', name: 'Paved Plaza', cat: 'infrastructure', size: 1, cost: 18, upkeep: 0, workers: 0,
    desc: 'Dressed stone paving. Acts as a road and lifts the desirability of everything around it.',
    desirability: D(4, 3, 1),
    art: { style: 'road', base: '#d6c9a6', roof: '#d6c9a6', height: 0 },
  },
  {
    id: 'roadblock', name: 'Roadblock', cat: 'infrastructure', size: 1, cost: 12, upkeep: 0, workers: 0,
    desc: 'Roaming walkers will not pass. Indispensable for steering service around your districts.',
    art: { style: 'road', base: '#8a6f45', roof: '#5d4a2e', height: 6 },
  },
  {
    id: 'garden', name: 'Garden', cat: 'infrastructure', size: 1, cost: 24, upkeep: 0, workers: 0,
    desc: 'Palms, a pool and shade. Cheap desirability — the backbone of every fine district.',
    desirability: D(9, 5, 2),
    art: { style: 'garden', base: '#4e7c3a', roof: '#6ba04a', height: 4 },
  },
  {
    id: 'statue_sm', name: 'Small Statue', cat: 'infrastructure', size: 1, cost: 60, upkeep: 0, workers: 0,
    desc: 'A carved likeness of a nomarch. Modest, and modestly admired.',
    desirability: D(12, 5, 3),
    art: { style: 'stone', base: '#c3b28c', roof: '#ddd0ae', height: 16 },
  },
  {
    id: 'statue_lg', name: 'Large Statue', cat: 'infrastructure', size: 3, cost: 240, upkeep: 2, workers: 0,
    desc: 'A colossal seated figure. Visible across the district and adored accordingly.',
    desirability: D(26, 9, 3),
    art: { style: 'stone', base: '#c9bd94', roof: '#e2d5b2', height: 34 },
  },

  // ---------------- Housing ----------------
  {
    id: 'house', name: 'Housing', cat: 'housing', size: 1, cost: 10, upkeep: 0, workers: 0,
    desc: 'Marks land for settlement. Immigrants raise their own huts; services turn huts into estates.',
    needsRoad: true, fireRisk: 0.4, damageRisk: 0.3,
    art: { style: 'house', base: '#b9a077', roof: '#8a6a3f', height: 12 },
  },

  // ---------------- Water ----------------
  {
    id: 'well', name: 'Well', cat: 'water', size: 1, cost: 30, upkeep: 0, workers: 0,
    desc: 'A hand-dug shaft. Houses close by draw from it directly — no water carrier walks a route.',
    service: 'wellWater', directRange: 4,
    desirability: D(-1, 2, 1),
    art: { style: 'stone', base: '#9a8e74', roof: '#6f6553', height: 8 },
  },
  {
    id: 'water_supply', name: 'Water Supply', cat: 'water', size: 2, cost: 90, upkeep: 2, workers: 6,
    sector: 'infrastructure', needsRoad: true,
    desc: 'Water carriers walk the streets with jars. Required by anything grander than a shanty.',
    service: 'water', walkerRange: 26, walkerInterval: 240,
    art: { style: 'stone', base: '#93a7a0', roof: '#5f7a72', height: 14 },
  },

  // ---------------- Food ----------------
  {
    id: 'farm_grain', name: 'Barley Farm', cat: 'food', size: 3, cost: 40, upkeep: 2, workers: 10,
    sector: 'food', terrain: 'floodplain', needsRoad: true,
    desc: 'Barley from the black land. Yield rises and falls with the fertility left by the inundation.',
    produces: 'grain', produceQty: 90, cycleTicks: 900,
    desirability: D(-2, 3, 1),
    art: { style: 'farm', base: '#8a7a44', roof: '#b9a05c', height: 6 },
  },
  {
    id: 'farm_veg', name: 'Chickpea Farm', cat: 'food', size: 3, cost: 40, upkeep: 2, workers: 10,
    sector: 'food', terrain: 'floodplain', needsRoad: true,
    desc: 'Pulses and greens. A second food type is the gate to a great many housing levels.',
    produces: 'vegetables', produceQty: 76, cycleTicks: 900,
    desirability: D(-2, 3, 1),
    art: { style: 'farm', base: '#6f8a45', roof: '#8fae5c', height: 6 },
  },
  {
    id: 'farm_fruit', name: 'Pomegranate Grove', cat: 'food', size: 3, cost: 55, upkeep: 2, workers: 10,
    sector: 'food', terrain: 'floodplain', needsRoad: true,
    desc: 'Orchard fruit. Slower to bear than grain but prized on the trade routes.',
    produces: 'fruit', produceQty: 64, cycleTicks: 1050,
    desirability: D(1, 3, 1),
    art: { style: 'farm', base: '#6a7f3c', roof: '#a84f66', height: 9 },
  },
  {
    id: 'farm_flax', name: 'Flax Farm', cat: 'food', size: 3, cost: 50, upkeep: 2, workers: 10,
    sector: 'food', terrain: 'floodplain', needsRoad: true,
    desc: 'Not food, but the fibre behind every bolt of linen your weavers will ever make.',
    produces: 'flax', produceQty: 40, cycleTicks: 950,
    desirability: D(-2, 3, 1),
    art: { style: 'farm', base: '#7d8a5a', roof: '#a9b57a', height: 6 },
  },
  {
    id: 'hunting_lodge', name: 'Hunting Lodge', cat: 'food', size: 2, cost: 40, upkeep: 2, workers: 6,
    sector: 'food', terrain: 'dry', needsRoad: true,
    desc: 'Hunters bring down gazelle and ostrich on the red land. Independent of the flood.',
    produces: 'meat', produceQty: 50, cycleTicks: 800,
    desirability: D(-3, 3, 1),
    art: { style: 'reed', base: '#8a6a45', roof: '#6b5334', height: 10 },
  },
  {
    id: 'fishing_wharf', name: 'Fishing Wharf', cat: 'food', size: 2, cost: 60, upkeep: 2, workers: 6,
    sector: 'food', terrain: 'water-adjacent', needsRoad: true,
    desc: 'Reed skiffs work the shallows. The Nile feeds a city that has lost its fields.',
    produces: 'fish', produceQty: 58, cycleTicks: 700,
    desirability: D(-4, 3, 1),
    art: { style: 'water', base: '#7d6a45', roof: '#5f7a86', height: 8 },
  },

  // ---------------- Industry ----------------
  {
    id: 'clay_pit', name: 'Clay Pit', cat: 'industry', size: 2, cost: 40, upkeep: 2, workers: 8,
    sector: 'industry', terrain: 'water-adjacent', needsRoad: true,
    desc: 'Nile silt dug and puddled. Feeds potters and brickworks alike.',
    produces: 'clay', produceQty: 20, cycleTicks: 620,
    desirability: D(-6, 4, 2), diseaseRisk: 0.02,
    art: { style: 'mine', base: '#8a5a3b', roof: '#6b4530', height: 5 },
  },
  {
    id: 'reed_gatherer', name: 'Reed Gatherer', cat: 'industry', size: 2, cost: 34, upkeep: 1, workers: 6,
    sector: 'industry', terrain: 'water-adjacent', needsRoad: true,
    desc: 'Cut papyrus reed from the marshes — the raw stock of scrolls and small boats.',
    produces: 'reeds', produceQty: 20, cycleTicks: 600,
    desirability: D(-3, 3, 1), diseaseRisk: 0.03,
    art: { style: 'reed', base: '#6f8a45', roof: '#55702f', height: 8 },
  },
  {
    id: 'straw_gatherer', name: 'Straw Gatherer', cat: 'industry', size: 2, cost: 30, upkeep: 1, workers: 5,
    sector: 'industry', needsRoad: true,
    desc: 'Chaff bound into bales. Mixed with clay it becomes mud brick.',
    produces: 'straw', produceQty: 24, cycleTicks: 560,
    desirability: D(-2, 3, 1),
    art: { style: 'reed', base: '#c9ae63', roof: '#a08a44', height: 7 },
  },
  {
    id: 'potter', name: 'Potter', cat: 'industry', size: 2, cost: 60, upkeep: 3, workers: 8,
    sector: 'industry', needsRoad: true,
    desc: 'Wheel-thrown jars and bowls. The first manufactured good any household demands.',
    consumes: { clay: 10 }, produces: 'pottery', produceQty: 10, cycleTicks: 620,
    desirability: D(-5, 4, 2), fireRisk: 1.4,
    art: { style: 'mud', base: '#a86a45', roof: '#7d4a30', height: 12 },
  },
  {
    id: 'brickworks', name: 'Brickworks', cat: 'industry', size: 2, cost: 60, upkeep: 3, workers: 8,
    sector: 'industry', needsRoad: true,
    desc: 'Mud brick moulded and sun-dried. Every monument short of a pyramid starts here.',
    consumes: { clay: 8, straw: 8 }, produces: 'bricks', produceQty: 12, cycleTicks: 640,
    desirability: D(-5, 4, 2),
    art: { style: 'mud', base: '#9c6a45', roof: '#74492f', height: 10 },
  },
  {
    id: 'weaver', name: 'Weaver', cat: 'industry', size: 2, cost: 70, upkeep: 3, workers: 8,
    sector: 'industry', needsRoad: true,
    desc: 'Flax spun and woven into linen — clothing for the living and wrapping for the dead.',
    consumes: { flax: 10 }, produces: 'linen', produceQty: 9, cycleTicks: 680,
    desirability: D(-4, 4, 2), fireRisk: 1.2,
    art: { style: 'mud', base: '#b0a385', roof: '#7f7460', height: 12 },
  },
  {
    id: 'brewery', name: 'Brewery', cat: 'industry', size: 2, cost: 70, upkeep: 3, workers: 8,
    sector: 'industry', needsRoad: true,
    desc: 'Barley mash fermented in vats. Beer is wages, medicine and celebration in one jar.',
    consumes: { grain: 12 }, produces: 'beer', produceQty: 9, cycleTicks: 700,
    desirability: D(-4, 4, 2), fireRisk: 1.0,
    art: { style: 'mud', base: '#a08447', roof: '#755c2f', height: 12 },
  },
  {
    id: 'papyrus_maker', name: 'Papyrus Maker', cat: 'industry', size: 2, cost: 75, upkeep: 3, workers: 8,
    sector: 'industry', needsRoad: true,
    desc: 'Reed pith pressed into sheets. Scribes and traders will take every roll you make.',
    consumes: { reeds: 10 }, produces: 'papyrus', produceQty: 9, cycleTicks: 680,
    desirability: D(-3, 4, 2),
    art: { style: 'mud', base: '#ded2a6', roof: '#a89a6e', height: 11 },
  },
  {
    id: 'jeweler', name: "Jeweler's Workshop", cat: 'industry', size: 2, cost: 110, upkeep: 5, workers: 10,
    sector: 'industry', needsRoad: true,
    desc: 'Gold drawn and gems set. Only the finest houses will settle for anything less.',
    consumes: { gold: 8, gems: 4 }, produces: 'luxury', produceQty: 6, cycleTicks: 820,
    desirability: D(-2, 4, 2),
    art: { style: 'mud', base: '#c9a94a', roof: '#8a7226', height: 13 },
  },
  {
    id: 'weaponsmith', name: 'Weaponsmith', cat: 'industry', size: 2, cost: 100, upkeep: 4, workers: 10,
    sector: 'industry', needsRoad: true,
    desc: 'Copper smelted into spearheads and axes. Arms your forts and pays your tribute.',
    consumes: { copper: 10 }, produces: 'weapons', produceQty: 8, cycleTicks: 780,
    desirability: D(-6, 4, 2), fireRisk: 1.8,
    art: { style: 'mud', base: '#8f7a63', roof: '#5f5044', height: 13 },
  },
  {
    id: 'chariot_maker', name: 'Chariot Maker', cat: 'industry', size: 3, cost: 160, upkeep: 6, workers: 12,
    sector: 'industry', needsRoad: true,
    desc: 'Bentwood, leather and bronze fittings. The most valuable thing your city can export.',
    consumes: { timber: 10, copper: 6 }, produces: 'chariots', produceQty: 4, cycleTicks: 1000,
    desirability: D(-5, 4, 2), fireRisk: 1.6,
    art: { style: 'mud', base: '#8a6a44', roof: '#5f4a2e', height: 14 },
  },
  {
    id: 'timber_yard', name: 'Timber Yard', cat: 'industry', size: 2, cost: 60, upkeep: 3, workers: 8,
    sector: 'industry', needsRoad: true,
    desc: 'Fells and squares acacia and sycamore. Egypt has little good wood; guard what you have.',
    produces: 'timber', produceQty: 12, cycleTicks: 760,
    desirability: D(-4, 4, 2),
    art: { style: 'mine', base: '#7a5433', roof: '#5b3f26', height: 9 },
  },
  {
    id: 'copper_mine', name: 'Copper Mine', cat: 'industry', size: 2, cost: 90, upkeep: 4, workers: 12,
    sector: 'industry', terrain: 'rock', needsRoad: true,
    desc: 'Galleries driven into the desert rock. Hot, dangerous, and utterly necessary.',
    produces: 'copper', produceQty: 12, cycleTicks: 820,
    desirability: D(-8, 5, 2),
    art: { style: 'mine', base: '#b5713c', roof: '#7a4b28', height: 8 },
  },
  {
    id: 'gold_mine', name: 'Gold Mine', cat: 'industry', size: 2, cost: 140, upkeep: 6, workers: 14,
    sector: 'industry', terrain: 'rock', needsRoad: true,
    desc: 'The wealth of Nubia. Gold buys mercenaries, monuments and the favour of Pharaoh.',
    produces: 'gold', produceQty: 8, cycleTicks: 900,
    desirability: D(-8, 5, 2),
    art: { style: 'mine', base: '#e0b437', roof: '#9a7a1e', height: 8 },
  },
  {
    id: 'gem_mine', name: 'Gemstone Mine', cat: 'industry', size: 2, cost: 150, upkeep: 6, workers: 14,
    sector: 'industry', terrain: 'rock', needsRoad: true,
    desc: 'Turquoise and carnelian prised from the hills of Sinai.',
    produces: 'gems', produceQty: 6, cycleTicks: 940,
    desirability: D(-8, 5, 2),
    art: { style: 'mine', base: '#59a5c4', roof: '#356e85', height: 8 },
  },
  {
    id: 'quarry_limestone', name: 'Limestone Quarry', cat: 'industry', size: 3, cost: 110, upkeep: 5, workers: 14,
    sector: 'industry', terrain: 'rock', needsRoad: true,
    desc: 'Fine white casing stone. No pyramid rises without it.',
    produces: 'limestone', produceQty: 10, cycleTicks: 880,
    desirability: D(-9, 5, 2),
    art: { style: 'mine', base: '#cdc3a8', roof: '#9a917a', height: 7 },
  },
  {
    id: 'quarry_sandstone', name: 'Sandstone Quarry', cat: 'industry', size: 3, cost: 100, upkeep: 5, workers: 14,
    sector: 'industry', terrain: 'rock', needsRoad: true,
    desc: 'Warm golden block, the workhorse stone of temple walls and pylons.',
    produces: 'sandstone', produceQty: 10, cycleTicks: 860,
    desirability: D(-9, 5, 2),
    art: { style: 'mine', base: '#c9a172', roof: '#96754c', height: 7 },
  },
  {
    id: 'quarry_granite', name: 'Granite Quarry', cat: 'industry', size: 3, cost: 170, upkeep: 7, workers: 18,
    sector: 'industry', terrain: 'rock', needsRoad: true,
    desc: 'Aswan granite, hard as anger. Reserved for obelisks, sarcophagi and sanctuaries.',
    produces: 'granite', produceQty: 7, cycleTicks: 1000,
    desirability: D(-10, 5, 2),
    art: { style: 'mine', base: '#8d7f76', roof: '#5f554e', height: 7 },
  },

  // ---------------- Distribution ----------------
  {
    id: 'granary', name: 'Granary', cat: 'distribution', size: 3, cost: 100, upkeep: 3, workers: 8,
    sector: 'distribution', needsRoad: true,
    desc: 'Domed silos for the harvest. Farmers deliver here; bazaars draw from here.',
    storage: 3200, desirability: D(-4, 4, 2),
    art: { style: 'mud', base: '#c2a468', roof: '#9a7f45', height: 18 },
  },
  {
    id: 'storage_yard', name: 'Storage Yard', cat: 'distribution', size: 3, cost: 90, upkeep: 3, workers: 8,
    sector: 'distribution', needsRoad: true,
    desc: 'Open stockpiles under matting. Holds everything that is not food.',
    storage: 1600, desirability: D(-6, 4, 2),
    art: { style: 'mud', base: '#a89272', roof: '#7d6a4e', height: 8 },
  },
  {
    id: 'bazaar', name: 'Bazaar', cat: 'distribution', size: 2, cost: 60, upkeep: 3, workers: 8,
    sector: 'distribution', needsRoad: true,
    desc: 'Buyers fetch stock from your stores; sellers walk it to the doorstep of every house.',
    walkerRange: 22, walkerInterval: 200,
    desirability: D(-2, 3, 1), fireRisk: 1.2,
    art: { style: 'reed', base: '#b5804a', roof: '#c9564a', height: 10 },
  },

  // ---------------- Religion ----------------
  ...(GOD_IDS.flatMap((g): BuildingDef[] => {
    const god = GODS[g];
    return [
      {
        id: `shrine_${g}`, name: `Shrine to ${god.name}`, cat: 'religion', size: 1, cost: 60, upkeep: 1, workers: 0,
        god: g, desc: `A wayside shrine. Pleases ${god.name} a little; delivers no service to houses.`,
        desirability: D(4, 3, 1),
        art: { style: 'temple', base: '#c8bb95', roof: god.color, height: 14 },
      },
      {
        id: `temple_${g}`, name: `Temple of ${god.name}`, cat: 'religion', size: 2, cost: 140, upkeep: 4, workers: 8,
        sector: 'religion', god: g, needsRoad: true,
        desc: `Priests of ${god.name} walk the streets bearing the god's favour to your households.`,
        service: RELIGION_SERVICE[g], walkerRange: 26, walkerInterval: 300,
        desirability: D(10, 6, 2),
        art: { style: 'temple', base: '#d3c69e', roof: god.color, height: 24 },
      },
      {
        id: `complex_${g}`, name: `Temple Complex of ${god.name}`, cat: 'religion', size: 5, cost: 900, upkeep: 20, workers: 30,
        sector: 'religion', god: g, needsRoad: true,
        desc: `A walled precinct with pylons, a sacred lake and a college of priests. Pleases ${god.name} enormously.`,
        service: RELIGION_SERVICE[g], walkerRange: 40, walkerInterval: 180,
        desirability: D(34, 12, 3),
        art: { style: 'temple', base: '#ded0a4', roof: god.color, height: 40 },
      },
    ];
  })),
  {
    id: 'festival_square', name: 'Festival Square', cat: 'religion', size: 5, cost: 300, upkeep: 4, workers: 0,
    desc: 'Where the god is carried out in procession. Required before you may hold a festival.',
    desirability: D(14, 8, 2),
    art: { style: 'road', base: '#e0d4ae', roof: '#c9b98a', height: 1 },
  },
  {
    id: 'oracle', name: 'Oracle', cat: 'religion', size: 2, cost: 200, upkeep: 4, workers: 0,
    desc: 'Petitioners come for omens. Steadily calms every god in the pantheon.',
    desirability: D(16, 7, 2),
    art: { style: 'temple', base: '#cdbf98', roof: '#8f7fc0', height: 22 },
  },

  // ---------------- Culture: education, entertainment, health ----------------
  {
    id: 'scribal_school', name: 'Scribal School', cat: 'culture', size: 2, cost: 90, upkeep: 4, workers: 8,
    sector: 'education', needsRoad: true,
    desc: 'Boys learn the reed pen and the hieratic hand. The first rung of education.',
    service: 'school', walkerRange: 24, walkerInterval: 320,
    desirability: D(6, 5, 2),
    art: { style: 'mud', base: '#c2b48c', roof: '#8a7a52', height: 14 },
  },
  {
    id: 'library', name: 'Library', cat: 'culture', size: 3, cost: 200, upkeep: 8, workers: 12,
    sector: 'education', needsRoad: true, consumes: { papyrus: 2 }, cycleTicks: 1200,
    desc: 'A house of scrolls. Consumes papyrus and raises the learning of the whole district.',
    service: 'library', walkerRange: 32, walkerInterval: 340,
    desirability: D(14, 7, 2),
    art: { style: 'stone', base: '#d0c39c', roof: '#7f6f4a', height: 20 },
  },
  {
    id: 'booth', name: 'Booth', cat: 'culture', size: 1, cost: 40, upkeep: 2, workers: 3,
    sector: 'culture', needsRoad: true,
    desc: 'A juggler works the corner. Simple pleasure, and a requirement sooner than you think.',
    service: 'booth', walkerRange: 20, walkerInterval: 260,
    desirability: D(3, 3, 1),
    art: { style: 'reed', base: '#b5804a', roof: '#d0a03f', height: 9 },
  },
  {
    id: 'bandstand', name: 'Bandstand', cat: 'culture', size: 2, cost: 90, upkeep: 4, workers: 6,
    sector: 'culture', needsRoad: true,
    desc: 'Harp, flute and sistrum. Musicians tour the streets from here.',
    service: 'bandstand', walkerRange: 26, walkerInterval: 280,
    desirability: D(8, 5, 2),
    art: { style: 'reed', base: '#c0a76e', roof: '#4f8ab5', height: 12 },
  },
  {
    id: 'pavilion', name: 'Pavilion', cat: 'culture', size: 3, cost: 180, upkeep: 7, workers: 10,
    sector: 'culture', needsRoad: true,
    desc: 'Dancers perform beneath a painted canopy. Great houses will not do without it.',
    service: 'pavilion', walkerRange: 30, walkerInterval: 300,
    desirability: D(16, 7, 2),
    art: { style: 'reed', base: '#cbb27c', roof: '#b04f7a', height: 16 },
  },
  {
    id: 'senet_house', name: 'Senet House', cat: 'culture', size: 2, cost: 130, upkeep: 6, workers: 8,
    sector: 'culture', needsRoad: true,
    desc: 'The game of passing. Quiet, absorbing, and demanded only by the very finest estates.',
    service: 'senet', walkerRange: 26, walkerInterval: 300,
    desirability: D(10, 5, 2),
    art: { style: 'mud', base: '#b9a577', roof: '#6f5c3a', height: 13 },
  },
  {
    id: 'juggler_school', name: 'Juggler School', cat: 'culture', size: 2, cost: 70, upkeep: 3, workers: 5,
    sector: 'culture', needsRoad: true,
    desc: 'Trains the performers your booths need. Without it, booths stand idle.',
    desirability: D(2, 3, 1),
    art: { style: 'mud', base: '#b08a55', roof: '#7a5f38', height: 11 },
  },
  {
    id: 'conservatory', name: 'Conservatory', cat: 'culture', size: 2, cost: 120, upkeep: 5, workers: 6,
    sector: 'culture', needsRoad: true,
    desc: 'Trains musicians for your bandstands.',
    desirability: D(4, 4, 1),
    art: { style: 'mud', base: '#b5a06a', roof: '#4f7fa5', height: 13 },
  },
  {
    id: 'dance_school', name: 'Dance School', cat: 'culture', size: 2, cost: 160, upkeep: 6, workers: 8,
    sector: 'culture', needsRoad: true,
    desc: 'Trains dancers for your pavilions.',
    desirability: D(5, 4, 1),
    art: { style: 'mud', base: '#bda66f', roof: '#a04f70', height: 13 },
  },
  {
    id: 'apothecary', name: 'Apothecary', cat: 'culture', size: 1, cost: 50, upkeep: 3, workers: 5,
    sector: 'health', needsRoad: true,
    desc: 'Herbs, honey and charms against the fever of the marshes.',
    service: 'apothecary', walkerRange: 24, walkerInterval: 280,
    desirability: D(2, 3, 1),
    art: { style: 'mud', base: '#a8b58f', roof: '#6f7c58', height: 11 },
  },
  {
    id: 'physician', name: 'Physician', cat: 'culture', size: 1, cost: 70, upkeep: 4, workers: 6,
    sector: 'health', needsRoad: true,
    desc: 'A swnw trained in the House of Life. Holds back plague where it walks.',
    service: 'physician', walkerRange: 26, walkerInterval: 300,
    desirability: D(3, 3, 1),
    art: { style: 'mud', base: '#9fb0a8', roof: '#5f7069', height: 12 },
  },
  {
    id: 'dentist', name: 'Dentist', cat: 'culture', size: 1, cost: 60, upkeep: 3, workers: 5,
    sector: 'health', needsRoad: true,
    desc: 'Sand in the bread wears teeth to stumps. Someone must see to it.',
    service: 'dentist', walkerRange: 24, walkerInterval: 300,
    desirability: D(2, 3, 1),
    art: { style: 'mud', base: '#b0aa93', roof: '#6f6a54', height: 11 },
  },
  {
    id: 'mortuary', name: 'Mortuary', cat: 'culture', size: 2, cost: 90, upkeep: 5, workers: 8,
    sector: 'health', needsRoad: true,
    desc: 'Embalmers see the dead safely west. Grim to live beside, but the great demand it.',
    service: 'mortuary', walkerRange: 26, walkerInterval: 320,
    desirability: D(-8, 5, 2),
    art: { style: 'stone', base: '#b2a894', roof: '#5f584a', height: 15 },
  },

  // ---------------- Government ----------------
  {
    id: 'tax_collector', name: 'Tax Collector', cat: 'government', size: 1, cost: 60, upkeep: 3, workers: 4,
    sector: 'government', needsRoad: true,
    desc: 'Assesses each household. Untaxed houses pay you nothing at all.',
    service: 'tax', walkerRange: 28, walkerInterval: 300,
    desirability: D(-2, 3, 1),
    art: { style: 'mud', base: '#b59a63', roof: '#7a6338', height: 13 },
  },
  {
    id: 'firehouse', name: 'Firehouse', cat: 'government', size: 1, cost: 50, upkeep: 3, workers: 6,
    sector: 'government', needsRoad: true,
    desc: 'Watchmen with water jars. Fire is the fastest way to lose a district you spent a decade building.',
    service: 'fire', walkerRange: 26, walkerInterval: 180,
    art: { style: 'mud', base: '#a8703f', roof: '#6f4526', height: 12 },
  },
  {
    id: 'architect_post', name: "Architect's Post", cat: 'government', size: 1, cost: 60, upkeep: 3, workers: 6,
    sector: 'government', needsRoad: true,
    desc: 'Surveyors shore up sagging walls. Neglect this and buildings simply fall down.',
    service: 'architect', walkerRange: 26, walkerInterval: 180,
    art: { style: 'mud', base: '#9a8f6f', roof: '#665c42', height: 12 },
  },
  {
    id: 'courthouse', name: 'Courthouse', cat: 'government', size: 2, cost: 120, upkeep: 5, workers: 8,
    sector: 'government', needsRoad: true,
    desc: 'Magistrates hear disputes and suppress crime before it becomes a riot.',
    service: 'magistrate', walkerRange: 30, walkerInterval: 260,
    desirability: D(6, 5, 2),
    art: { style: 'stone', base: '#c5b790', roof: '#7f7048', height: 18 },
  },
  {
    id: 'mansion', name: 'Personal Mansion', cat: 'government', size: 3, cost: 400, upkeep: 10, workers: 0,
    desc: 'Your own residence. Raises your salary, and its grandeur reflects on the whole city.',
    desirability: D(24, 10, 3),
    art: { style: 'stone', base: '#dcccA0', roof: '#8f7442', height: 28 },
  },
  {
    id: 'work_camp', name: 'Work Camp', cat: 'government', size: 2, cost: 60, upkeep: 3, workers: 20,
    sector: 'monument', needsRoad: true,
    desc: 'Corvée labourers, fed and housed. Nothing monumental is raised without them.',
    desirability: D(-6, 4, 2),
    art: { style: 'reed', base: '#a88a5a', roof: '#7a6238', height: 8 },
  },
  {
    id: 'stonemason_guild', name: "Stonemasons' Guild", cat: 'government', size: 2, cost: 100, upkeep: 5, workers: 12,
    sector: 'monument', needsRoad: true,
    desc: 'Dresses quarried block into fitted stone at the monument site.',
    desirability: D(-4, 4, 2),
    art: { style: 'mud', base: '#b0a68c', roof: '#6f6650', height: 12 },
  },
  {
    id: 'bricklayer_guild', name: "Bricklayers' Guild", cat: 'government', size: 2, cost: 80, upkeep: 4, workers: 12,
    sector: 'monument', needsRoad: true,
    desc: 'Lays mud brick for mastabas, ramps and pyramid cores.',
    desirability: D(-4, 4, 2),
    art: { style: 'mud', base: '#9c7452', roof: '#6b4f34', height: 12 },
  },
  {
    id: 'carpenter_guild', name: "Carpenters' Guild", cat: 'government', size: 2, cost: 100, upkeep: 5, workers: 12,
    sector: 'monument', needsRoad: true,
    desc: 'Sledges, scaffolds and levers. The unglamorous half of every great work.',
    desirability: D(-4, 4, 2),
    art: { style: 'mud', base: '#8a6a44', roof: '#5f4a2e', height: 12 },
  },
  {
    id: 'artisan_guild', name: "Artisans' Guild", cat: 'government', size: 2, cost: 140, upkeep: 6, workers: 12,
    sector: 'monument', needsRoad: true,
    desc: 'Painters and gilders who finish a monument so that it is fit to be seen by a god.',
    desirability: D(-2, 4, 2),
    art: { style: 'mud', base: '#bfa25e', roof: '#8a6f34', height: 12 },
  },

  // ---------------- Trade ----------------
  {
    id: 'dock', name: 'Dock', cat: 'trade', size: 3, cost: 140, upkeep: 5, workers: 12,
    sector: 'trade', terrain: 'water-adjacent', needsRoad: true,
    desc: 'Trading ships moor here. River routes carry far more cargo than any caravan.',
    desirability: D(-4, 4, 2),
    art: { style: 'water', base: '#8a6a45', roof: '#6f5334', height: 8 },
  },
  {
    id: 'trading_post', name: 'Trading Post', cat: 'trade', size: 3, cost: 120, upkeep: 5, workers: 10,
    sector: 'trade', needsRoad: true,
    desc: 'Donkey caravans from the desert routes unload here.',
    desirability: D(-3, 4, 2),
    art: { style: 'reed', base: '#b08a55', roof: '#8a5f3a', height: 10 },
  },
  {
    id: 'ferry', name: 'Ferry Landing', cat: 'trade', size: 1, cost: 40, upkeep: 1, workers: 2,
    sector: 'infrastructure', terrain: 'water-adjacent',
    desc: 'Walkers cross the river between a matched pair of landings.',
    art: { style: 'water', base: '#8a6a45', roof: '#6f5334', height: 4 },
  },

  // ---------------- Military ----------------
  {
    id: 'recruiter', name: 'Recruiter', cat: 'military', size: 2, cost: 80, upkeep: 3, workers: 6,
    sector: 'military', needsRoad: true,
    desc: 'Enlists young men from your housing. Forts stand empty without one.',
    desirability: D(-4, 4, 2),
    art: { style: 'mud', base: '#9a7a55', roof: '#6b5238', height: 12 },
  },
  {
    id: 'fort_infantry', name: 'Infantry Fort', cat: 'military', size: 4, cost: 300, upkeep: 12, workers: 0,
    garrison: 16, troopType: 'infantry', needsRoad: true,
    desc: 'A company of spearmen. Steady in the line, slow to arrive.',
    consumes: { weapons: 4 }, cycleTicks: 2400,
    desirability: D(-8, 5, 2),
    art: { style: 'tower', base: '#b09a70', roof: '#7a6844', height: 20 },
  },
  {
    id: 'fort_archers', name: 'Archer Fort', cat: 'military', size: 4, cost: 320, upkeep: 12, workers: 0,
    garrison: 16, troopType: 'archers', needsRoad: true,
    desc: 'Bowmen who break an assault before it reaches your walls.',
    consumes: { weapons: 4 }, cycleTicks: 2400,
    desirability: D(-8, 5, 2),
    art: { style: 'tower', base: '#a89468', roof: '#6f6040', height: 20 },
  },
  {
    id: 'fort_chariots', name: 'Chariot Fort', cat: 'military', size: 4, cost: 480, upkeep: 18, workers: 0,
    garrison: 12, troopType: 'charioteers', needsRoad: true,
    desc: 'Fast, terrifying and ruinously expensive. Egypt won its empire with these.',
    consumes: { chariots: 3 }, cycleTicks: 3000,
    desirability: D(-8, 5, 2),
    art: { style: 'tower', base: '#b5a06f', roof: '#7f6a42', height: 20 },
  },
  {
    id: 'academy', name: 'Military Academy', cat: 'military', size: 3, cost: 240, upkeep: 10, workers: 10,
    sector: 'military', needsRoad: true,
    desc: 'Drills your companies to a higher standard. Trained troops fight far above their number.',
    desirability: D(-4, 4, 2),
    art: { style: 'stone', base: '#c0ad80', roof: '#7f6c44', height: 18 },
  },
  {
    id: 'wall', name: 'Mudbrick Wall', cat: 'military', size: 1, cost: 12, upkeep: 0, workers: 0,
    desc: 'Slows and channels an attacker. Enemies must batter it down or find a gate.',
    art: { style: 'tower', base: '#a89070', roof: '#7f6a50', height: 20 },
  },
  {
    id: 'tower', name: 'Watchtower', cat: 'military', size: 2, cost: 90, upkeep: 3, workers: 4,
    sector: 'military', desc: 'Archers on the wall shoot anything that comes within range.',
    art: { style: 'tower', base: '#b09878', roof: '#6f5c44', height: 34 },
  },
  {
    id: 'gatehouse', name: 'Gatehouse', cat: 'military', size: 2, cost: 100, upkeep: 2, workers: 0,
    desc: 'Lets your own people through a wall while keeping enemies out.',
    art: { style: 'tower', base: '#b5a082', roof: '#7a6852', height: 24 },
  },

  // ---------------- Monuments ----------------
  {
    id: 'mon_mastaba', name: 'Mastaba', cat: 'monument', size: 5, cost: 200, upkeep: 0, workers: 0,
    desc: 'A bench-shaped tomb of mud brick over a rock-cut chamber. The ancestor of every pyramid.',
    desirability: D(20, 10, 3),
    monument: {
      points: 15,
      stages: [
        { name: 'Excavate the shaft', materials: {}, labor: 400 },
        { name: 'Lay the brick core', materials: { bricks: 120 }, labor: 900 },
        { name: 'Face and seal', materials: { bricks: 60, limestone: 40 }, labor: 600 },
      ],
    },
    art: { style: 'monument', base: '#a67f56', roof: '#8a6742', height: 26 },
  },
  {
    id: 'mon_step_pyramid', name: 'Step Pyramid', cat: 'monument', size: 7, cost: 500, upkeep: 0, workers: 0,
    desc: 'Six mastabas stacked upon one another, as Imhotep first conceived it for Djoser.',
    desirability: D(34, 16, 3),
    monument: {
      points: 40,
      stages: [
        { name: 'Level the platform', materials: {}, labor: 900 },
        { name: 'Raise the first tiers', materials: { bricks: 240, limestone: 120 }, labor: 2000 },
        { name: 'Raise the upper tiers', materials: { limestone: 220, granite: 40 }, labor: 2400 },
        { name: 'Dress the casing', materials: { limestone: 160 }, labor: 1400 },
      ],
    },
    art: { style: 'monument', base: '#c9bb95', roof: '#a8987a', height: 58 },
  },
  {
    id: 'mon_pyramid', name: 'Great Pyramid', cat: 'monument', size: 9, cost: 1200, upkeep: 0, workers: 0,
    desc: 'A true pyramid faced in white limestone. The work of a generation and the pride of an age.',
    desirability: D(50, 22, 3),
    monument: {
      points: 100,
      stages: [
        { name: 'Survey and level the bedrock', materials: {}, labor: 1800 },
        { name: 'Cut the burial chamber', materials: { granite: 90 }, labor: 2200 },
        { name: 'Raise the core', materials: { limestone: 520, sandstone: 260 }, labor: 6000 },
        { name: 'Raise the upper courses', materials: { limestone: 420 }, labor: 4500 },
        { name: 'Set the casing and capstone', materials: { limestone: 300, granite: 60, gold: 20 }, labor: 3000 },
      ],
    },
    art: { style: 'monument', base: '#ded3b0', roof: '#c2b48c', height: 96 },
  },
  {
    id: 'mon_sphinx', name: 'Sphinx', cat: 'monument', size: 7, cost: 700, upkeep: 0, workers: 0,
    desc: 'A lion with the face of the king, carved from the living rock and painted in ochre.',
    desirability: D(40, 18, 3),
    monument: {
      points: 55,
      stages: [
        { name: 'Free the body from the bedrock', materials: {}, labor: 2200 },
        { name: 'Carve the head and nemes', materials: { limestone: 180 }, labor: 2600 },
        { name: 'Paint and dedicate', materials: { limestone: 60, gold: 15 }, labor: 1200 },
      ],
    },
    art: { style: 'monument', base: '#d0b184', roof: '#b0895c', height: 40 },
  },
  {
    id: 'mon_obelisk', name: 'Obelisk', cat: 'monument', size: 3, cost: 400, upkeep: 0, workers: 0,
    desc: 'A single shaft of Aswan granite tipped with electrum, a frozen ray of Ra.',
    desirability: D(30, 12, 3),
    monument: {
      points: 30,
      stages: [
        { name: 'Quarry and free the shaft', materials: { granite: 140 }, labor: 1600 },
        { name: 'Drag and raise', materials: { timber: 80 }, labor: 1800 },
        { name: 'Gild the pyramidion', materials: { gold: 25 }, labor: 500 },
      ],
    },
    art: { style: 'monument', base: '#a58f80', roof: '#e0b437', height: 88 },
  },
  {
    id: 'mon_sun_temple', name: 'Sun Temple', cat: 'monument', size: 7, cost: 900, upkeep: 0, workers: 0,
    desc: 'An open court with a squat obelisk at its heart, where Ra is worshipped under the sky.',
    desirability: D(38, 16, 3),
    monument: {
      points: 60,
      stages: [
        { name: 'Raise the terrace', materials: { sandstone: 200 }, labor: 2000 },
        { name: 'Build the courts and altar', materials: { sandstone: 260, limestone: 120 }, labor: 3000 },
        { name: 'Erect the benben', materials: { granite: 100, gold: 20 }, labor: 1600 },
      ],
    },
    art: { style: 'monument', base: '#d8bd8a', roof: '#e0a832', height: 52 },
  },
];

export const BUILDING_BY_ID: Record<string, BuildingDef> = Object.fromEntries(
  BUILDINGS.map((b) => [b.id, b]),
);

export const CATEGORY_META: Record<BuildCategory, { name: string; glyph: string; color: string }> = {
  infrastructure: { name: 'Roads', glyph: '🛣️', color: '#b89a5e' },
  housing:        { name: 'Housing', glyph: '🏠', color: '#c08a4e' },
  water:          { name: 'Water', glyph: '💧', color: '#5b93a8' },
  food:           { name: 'Food', glyph: '🌾', color: '#8aa84c' },
  industry:       { name: 'Industry', glyph: '⚒️', color: '#a8703f' },
  distribution:   { name: 'Storage', glyph: '📦', color: '#c2a468' },
  religion:       { name: 'Religion', glyph: '🛕', color: '#8f7fc0' },
  culture:        { name: 'Culture', glyph: '🎭', color: '#c9564a' },
  government:     { name: 'Government', glyph: '🏛️', color: '#b59a63' },
  military:       { name: 'Military', glyph: '⚔️', color: '#9aa2a8' },
  monument:       { name: 'Monuments', glyph: '🔺', color: '#ded3b0' },
  trade:          { name: 'Trade', glyph: '⛵', color: '#7fa8a0' },
};

export const CATEGORY_ORDER: BuildCategory[] = [
  'infrastructure', 'housing', 'water', 'food', 'industry', 'distribution',
  'religion', 'culture', 'government', 'trade', 'military', 'monument',
];

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const MONTHS = [
  'Thoth', 'Phaophi', 'Athyr', 'Choiak',        // Akhet — inundation
  'Tybi', 'Mechir', 'Phamenoth', 'Pharmuthi',   // Peret — emergence / growing
  'Pachons', 'Payni', 'Epiphi', 'Mesore',       // Shemu — harvest / low water
];

export type Season = 'akhet' | 'peret' | 'shemu';
export const SEASONS: Record<Season, { name: string; desc: string; color: string }> = {
  akhet: { name: 'Akhet', desc: 'Inundation — the river covers the fields', color: '#4f8fa8' },
  peret: { name: 'Peret', desc: 'Emergence — the crops grow in black earth', color: '#6f9a4c' },
  shemu: { name: 'Shemu', desc: 'Harvest — the low water and the reaping', color: '#c9a24a' },
};

export function seasonOfMonth(m: number): Season {
  return m < 4 ? 'akhet' : m < 8 ? 'peret' : 'shemu';
}
