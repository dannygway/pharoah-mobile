/**
 * Player settings that outlive a single game: graphics and the audio mix.
 *
 * Kept apart from saves, so loading a city never changes how the phone behaves, and
 * stored defensively — private browsing or blocked storage simply falls back to the
 * defaults rather than failing.
 */

export type GraphicsMode = 'battery' | 'balanced' | 'sharp';

export interface Settings {
  graphics: GraphicsMode;
  music: number;    // 0..1
  effects: number;  // 0..1
  ambience: number; // 0..1
  muted: boolean;
  haptics: boolean;
}

const DEFAULTS: Settings = {
  graphics: 'balanced', music: 0.55, effects: 0.8, ambience: 0.6, muted: false, haptics: true,
};

const KEY = 'kemet.settings';
let current: Settings = load();
const listeners: ((s: Settings) => void)[] = [];

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* storage unavailable: defaults it is */ }
  return { ...DEFAULTS };
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* not fatal */ }
  for (const fn of listeners) fn(current);
}

export function onSettingsChange(fn: (s: Settings) => void): void {
  listeners.push(fn);
}

/**
 * How the renderer should behave under each graphics mode.
 *
 * Resolution is capped below the screen's native 3× by default: the sprite art is
 * painted at 2×, so drawing at 3× buys no visible detail and costs 2.25× the GPU work,
 * which on a phone is heat and battery. Frame rate follows what the player is doing —
 * full speed only while a finger is on the glass or the camera is still moving.
 */
export function graphicsProfile(mode: GraphicsMode): {
  maxDpr: number; activeFps: number; runningFps: number; idleFps: number;
} {
  switch (mode) {
    case 'battery': return { maxDpr: 1.5, activeFps: 60, runningFps: 30, idleFps: 10 };
    case 'sharp': return { maxDpr: 3, activeFps: 120, runningFps: 120, idleFps: 30 };
    default: return { maxDpr: 2, activeFps: 120, runningFps: 60, idleFps: 20 };
  }
}
