# Design notes

Why the game is built the way it is. Useful if you want to change the balance, add a
mechanic, or work out why something behaves as it does.

## The tick

`TICKS_PER_MONTH = 360`, twelve months to a year, simulation fixed at 30 Hz. At 1× a
month takes twelve seconds of real time; speed multipliers take as many extra fixed steps
as they owe. The renderer never advances the simulation — it draws whatever the last
completed step left behind, and interpolates walker positions, so the frame rate and the
simulation rate are genuinely independent.

Work is spread across three cadences so the per-tick cost stays flat:

| Cadence | What runs |
| --- | --- |
| Every tick | Walkers, production progress, walker despatch, flood level |
| Every 30 ticks ("a day") | Desirability recompute (if dirty), service decay, fire/damage accrual, soil drawdown |
| Every 360 ticks (a month) | Labour allocation, household consumption, housing evolution, taxes, wages, immigration, health, statistics |

`Systems` runs on its own schedule on top: logistics every 90 ticks, monuments every 45,
gods/ratings/disasters/trade/military monthly, combat every 12.

## The walker model

This is the load-bearing mechanic and it is worth understanding before changing anything.

A service building with a `walkerInterval` periodically despatches a roamer from its road
entrance. Each step the roamer picks a neighbouring road tile, weighted:

- continuing straight: **3.2**
- any other direction: **1.0**
- back the way it came: **0.08**

so walkers travel in believable lines but still explore junctions. Roadblocks are excluded
from the candidate set, which is exactly how you seal a district. When it enters a tile it
services every building in the eight surrounding tiles. When its range is spent it paths
home, still servicing as it goes.

Everything else — carts, buyers, supply runs, immigrants, labourers, traders — follows a
BFS path instead of roaming, and roadblocks do not stop them.

The consequence, which is the whole design: **a service reaches a house only if a roamer
happens to walk past it.** Long ribbon developments starve. Compact loops with the service
block in the middle work. Roadblocks let you stop a priest wandering off into the industrial
quarter instead of servicing your housing.

## Housing

Twenty levels in `HOUSING`. Evolution is checked monthly, one step at a time:

1. If the house fails **its current level's** requirements, it devolves by one and evicts
   anyone over the new capacity.
2. Otherwise, if it meets **the next level's** requirements, it advances by one.
3. Either way it records a human-readable `blocker` string, which is what the UI shows.

Requirements ratchet in the classic order — shelter, water, a second food, pottery, a god,
a school, entertainment, medicine, then the luxuries. Desirability has both a floor and a
ceiling per level: a hut surrounded by estates is out of place and will be replaced.

Service freshness is a countdown (`SERVICE_DURATION`, eleven months) refreshed each time a
walker calls. Stop servicing a district and it slides back down the ladder over about a
year rather than collapsing instantly.

Not everything is walker-delivered. A building with a `directRange` serves houses in a
radius with no walker at all — the well is the case that matters, because nobody carries
well water, the neighbours simply come and draw it. Put wells *among* your housing, not in
the civic centre.

## Food and the flood

Farms on the floodplain multiply their output by the season — 0.15 in Akhet, 1.0 in Peret,
1.45 in Shemu — and produce nothing at all on a tile currently under water. Fertility
(0–100) scales output between 0.45× and 1.5×, drains while crops grow, and is restored by
silt when the flood recedes. Flood quality is rolled once a year from Osiris's mood plus
noise, so a neglected Osiris produces a visibly worse flood and a hungry year.

Households eat `0.30 × people` food units per month. Going short is survivable: a `hunger`
counter has to reach four consecutive hungry months before anyone actually leaves, and then
only a fraction. That grace period is load-bearing — without it a new settlement can never
start, because the first families must arrive before anyone exists to work the fields.

## Desirability

Recomputed in full at most once per simulated day, and only when something has been built
or destroyed. Each emitter writes a value into a square around its footprint, falling off
with Chebyshev distance from the footprint edge. Houses emit too: slums drag a district
down, estates lift it. Terrain has an opinion as well — marsh is unpleasant, riverside is
not, roads help slightly.

Full recompute over a 100×100 map with a few hundred emitters is on the order of 100k
operations, which is cheap once a day and far simpler to reason about than incremental
updates.

## Labour

Workforce is 42% of the housed population. Sectors are served in the player's chosen
priority order, and a sector that cannot be filled spreads what it gets evenly across its
buildings, so a shortage degrades everything a little rather than killing half of it
outright. Sectors below the shortfall get nothing, which is the point — the priority list
is a real decision. When demand exceeds supply by more than 15% the city says so in
plain language rather than silently stopping.

Staffing is a 0–1 ratio that scales production rate and walker despatch frequency, so a
half-staffed building is visibly sluggish rather than simply off.

## Monuments

Each monument has ordered stages, each needing both materials and raw labour. Materials
arrive as `store` entries carried by guild walkers from your storage yards and are folded
into `delivered`; labour arrives as work-camp walkers, each contributing 12 units. A stage
completes only when both are satisfied, at which point `built` advances and the visual
grows. The site emits *negative* desirability until it is finished.

Guild-to-material mapping lives in `GUILD_MATERIALS` in `systems.ts`.

## Rendering

The isometric projection is the standard 2:1 diamond — `TILE_W = 64`, `TILE_H = 32`:

```
screenX = (x - y) * 32
screenY = (x + y) * 16
```

Draw order is painter's algorithm by isometric diagonal. Rather than sorting every frame,
objects are **bucketed** into an array indexed by `x + y`, which is linear and allocates
nothing. A building of size *s* is bucketed by its front-most tile, `x + y + 2(s-1)`.
Walkers are bucketed by `floor(px + py)`.

Everything goes into one interleaved instance buffer (12 floats: position, size, UV rect,
tint) uploaded once per frame. Instances rasterise in submission order, so submitting in
painter's order gives correct occlusion with no depth buffer.

The atlas is packed by a shelf packer at a fixed 2048 width, growing to the next power of
two in height. Art at size ≤ 3 tiles is supersampled 2×; larger monuments are drawn 1× so
a 9×9 pyramid does not consume a quarter of the atlas on its own. Each sprite records its
own scale, which the renderer divides out, so callers work in logical pixels throughout.

No mipmaps: the atlas is tightly packed and mip bleeding between neighbouring sprites is far
more objectionable than the mild aliasing at minimum zoom.

## Saving

Saves are JSON in `localStorage`. The world's typed arrays are base64-encoded; buildings
are serialised individually; **walkers are not saved** — they are transient and simply
respawn, which keeps saves small and avoids persisting a lot of in-flight state that would
need careful validation on load. Autosave runs every 45 seconds of unpaused play and on
backgrounding.

## Immigration

Attractiveness is a sum: room to live in, food security, employment, tax rate and
prosperity. Two details matter more than they look.

First, a settlement of fewer than sixty people is not judged on its granaries at all.
Judging it on food would deadlock it permanently, because the first families have to
arrive before anyone exists to work the fields.

Second, settlers do not scatter uniformly across every empty lot. They fill houses that
already have people, and prefer the most desirable ground. Picking at random spreads a
small population so thinly across a large plan that no bazaar or priest can reach enough
of them — you get sprawl instead of a district, and nothing ever gets serviced.

## Balance levers

Most tuning lives in two places:

- `src/data.ts` — building costs, worker counts, production quantities and cycle times,
  desirability values, and the whole `HOUSING` ladder.
- `src/sim.ts` — consumption rates (`consumeHousehold`), the workforce fraction and
  allocation (`allocateLabor`), immigration attractiveness (`updateImmigration`), and the
  flood curve (`stepFlood`).

Mission-specific pacing — starting funds, unlocks, goals, trade routes, invasion and request
schedules — is all in `src/missions.ts`.
