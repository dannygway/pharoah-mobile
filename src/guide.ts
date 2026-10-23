/**
 * The first-mission guide: the opening of a city, one step at a time.
 *
 * Every step is read off the city itself rather than ticked by the player, so it can
 * never fall out of step with what is on the map — demolish the only well and "Dig a
 * well" comes back. Each step names the one building that answers it, so "Show me"
 * can arm it directly instead of sending the player hunting through menus.
 */

import type { Game } from './game';

export interface GuideStep {
  id: string;
  title: string;
  detail: string;
  /** What "Show me" arms. The first unlocked id in the list is used. */
  build: string[];
  done: (g: Game, roads: number) => boolean;
  /** Move the camera to somewhere this can go, if the player is looking elsewhere. */
  seek?: 'floodplain';
}

const count = (g: Game, ...ids: string[]) => ids.reduce((n, id) => n + g.city.countOf(id), 0);

export const GUIDE_MISSIONS = ['nubt'];

export const GUIDE: GuideStep[] = [
  {
    id: 'roads',
    title: 'Lay a road',
    detail: 'Everyone walks. Drag a road across the dry ground — a loop around a block works best.',
    build: ['road'],
    done: (_g, roads) => roads >= 12,
  },
  {
    id: 'houses',
    title: 'Mark out housing',
    detail: 'Paint plots touching the road. Settlers walk in and build their own huts.',
    build: ['house'],
    done: (g) => count(g, 'house') >= 6,
  },
  {
    id: 'water',
    title: 'Dig a well',
    detail: 'A hut without water stays a hut. Put the well among the plots; the halo shows which it reaches.',
    build: ['well', 'water_supply'],
    done: (g) => count(g, 'well', 'water_supply') >= 1,
  },
  {
    id: 'camp',
    title: 'Build a work camp',
    detail: 'Peasants walk out from the camp to farm the black land. Put it on dry ground near the floodplain, beside a road.',
    build: ['work_camp'],
    done: (g) => count(g, 'work_camp') >= 1,
  },
  {
    id: 'farms',
    title: 'Plant farms on the black land',
    detail: 'The flood feeds the floodplain. Farms there hire nobody — the camp\'s peasants work them.',
    build: ['farm_grain', 'farm_chickpea', 'farm_lettuce'],
    done: (g) => count(g, 'farm_grain', 'farm_chickpea', 'farm_lettuce', 'farm_barley', 'farm_flax', 'farm_fig', 'farm_pomegranate') >= 2,
    seek: 'floodplain',
  },
  {
    id: 'granary',
    title: 'Build a granary',
    detail: 'Harvests are carted to the granary. Keep it on a road between the farms and the houses.',
    build: ['granary'],
    done: (g) => count(g, 'granary') >= 1,
  },
  {
    id: 'bazaar',
    title: 'Open a bazaar',
    detail: 'Buyers fetch food from the granary; sellers walk it to the houses the halo touches.',
    build: ['bazaar'],
    done: (g) => count(g, 'bazaar') >= 1,
  },
  {
    id: 'faith',
    title: 'Raise a temple',
    detail: 'Huts become shanties once a priest walks past. Any god will do to begin with.',
    build: ['temple_osiris', 'temple_ra', 'shrine_osiris'],
    done: (g) => count(g, 'temple_osiris', 'temple_ra', 'temple_ptah', 'temple_seth', 'temple_bast') >= 1,
  },
  {
    id: 'safety',
    title: 'Firehouse and architect',
    detail: 'Mud brick burns and crumbles. One of each, on the road through the houses, keeps the walls up.',
    build: ['firehouse', 'architect_post'],
    done: (g) => count(g, 'firehouse') >= 1 && count(g, 'architect_post') >= 1,
  },
  {
    id: 'tax',
    title: 'Send out a tax collector',
    detail: 'Houses only pay when a collector walks past. Without one the treasury only falls.',
    build: ['tax_collector'],
    done: (g) => count(g, 'tax_collector') >= 1,
  },
];

/** The first unfinished step, or null when the opening is done. */
export function currentStep(g: Game): { step: GuideStep; index: number } | null {
  let roads = 0;
  const r = g.world.road;
  for (let i = 0; i < r.length; i++) roads += r[i];
  for (let i = 0; i < GUIDE.length; i++) {
    const s = GUIDE[i];
    if (!s.build.some((id) => g.isUnlocked(id))) continue;
    if (!s.done(g, roads)) return { step: s, index: i };
  }
  return null;
}
