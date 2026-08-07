/** Shared timing constants, kept in their own module so sim and walkers do not form a cycle. */

export const TICKS_PER_MONTH = 360;
export const TICKS_PER_YEAR = TICKS_PER_MONTH * 12;
/** Sixteen days to a month, as the reference design has it. */
export const DAYS_PER_MONTH = 16;
export const TICKS_PER_DAY = TICKS_PER_MONTH / DAYS_PER_MONTH;
/**
 * How long a delivered service stays fresh inside a house: roughly forty game days.
 * This is deliberately short. It is what produces the characteristic slow oscillation
 * of a marginal block — services flickering in and out, houses evolving and devolving —
 * whose correct diagnosis is always walker route reliability, never building count.
 */
export const SERVICE_DURATION = Math.round(TICKS_PER_DAY * 40);
/** Ticks a walker takes to cross one tile at base speed. */
export const TICKS_PER_TILE = 7;
