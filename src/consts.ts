/** Shared timing constants, kept in their own module so sim and walkers do not form a cycle. */

export const TICKS_PER_MONTH = 360;
export const TICKS_PER_YEAR = TICKS_PER_MONTH * 12;
/** How long a delivered service stays "fresh" inside a house. */
export const SERVICE_DURATION = TICKS_PER_MONTH * 11;
/** Ticks a walker takes to cross one tile at base speed. */
export const TICKS_PER_TILE = 7;
