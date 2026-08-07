# KEMET — Lord of the Two Lands

An Ancient Egypt city-builder in the *Pharaoh* lineage, written from scratch to run
locally on an iPhone. WebGL2, offline-first, installable to the home screen, 120Hz.

There are no image or audio assets. Every sprite is drawn procedurally into a texture
atlas at boot and every sound is synthesised with WebAudio, so the whole game — engine,
simulation, art and score — is about **64 KB gzipped**.

---

## What it actually simulates

This is a real implementation of the genre's mechanics, not a facade over a resource
counter.

**Walkers.** Nothing in the city is delivered by magic. A water carrier leaves the water
supply, walks the road network semi-randomly, and hands water to every house it passes.
So does the priest, the teacher, the tax collector, the physician and the bazaar seller.
Roadblocks stop roamers but not deliveries, so you steer service by shaping roads. If a
district has no road loop, it gets nothing — and that is the central puzzle of the game.

**The Nile.** The year is divided into Akhet, Peret and Shemu. During the inundation the
floodplain goes under water and every farm on it stops dead; you live on what is in the
granary. When the water falls it leaves silt behind and fertility recovers, in proportion
to how good the flood was — which Osiris decides based on how you have treated him.

**Housing.** Twenty levels, from a crude hut to a palatial estate, and each rung adds
exactly one new demand to everything below it: water, then a food type, a god, a piped
water supply, entertainment, pottery, a physician, beer, a magistrate, a school, a dentist,
linen, a second god, a third kind of entertainment and a luxury, and on up. From manor
level the residents become scribes: they stop working entirely and pay a great deal more
tax instead, so a city of nothing but fine housing has no workforce left to run it. Select
any house and it tells you exactly what is blocking it. Houses devolve the moment a
requirement lapses, and a delivered service goes stale in about forty game days — which is
what produces the characteristic slow oscillation of a marginal block.

**Production chains.** Clay → pottery. Flax → linen. Barley → beer. Reeds → papyrus.
Copper → weapons. Timber + copper → chariots. Gold + gems → jewellery. Farms deliver to
granaries by cart, storage yards push raw materials out to workshops, bazaar buyers fetch
stock and bazaar sellers walk it to the doorstep.

**Gods.** Osiris, Ra, Ptah, Seth and Bast each weigh the worship they receive against the
size of your city. Pleased, they bless you. Angered, Ra sets fires, Ptah wrecks workshops,
Seth summons an invasion, Bast looses plague and Osiris withholds the flood. Festivals buy
you back into favour.

**Monuments.** Mastabas, step pyramids, the Great Pyramid, a Sphinx, obelisks and sun
temples. Built in stages, each needing both hauled materials and raw labour. Work camps
supply the labour; bricklayers', stonemasons', carpenters' and artisans' guilds haul from
your storage yards. The Great Pyramid takes five stages and roughly 1,500 units of stone.

**Everything else.** Labour allocation by sector priority, taxation and treasury, trade
routes by land and river with import/export policy, invasions and forts, fire and collapse
and plague and tomb robbers, four ratings (Culture, Prosperity, Monument, Kingdom), and
Pharaoh's requests, which you ignore at your peril.

**Ten missions**, from a predynastic village at Nubt to Pi-Ramesses with the Hittites at
the gate, plus an unlimited sandbox.

---

## Telling you what is wrong

The desktop games in this lineage report state and leave diagnosis to the player. On a
phone, with less screen and less patience, that is the wrong trade — so this build names
the cause rather than the symptom. "Understaffed" is a symptom. "Its whole sector is being
outbid" is a cause you can act on.

**The reachability halo.** Select anything that sends a person out — a bazaar, a temple, a
water supply, a firehouse — and tap **Show reach**. Every road tile that walker could still
be standing on when its wander budget runs out lights up blue, and every house those tiles
touch lights up gold. If a house is not gold, that service will never arrive there, no
matter how many of the building you put up. It changes nothing in the simulation; it makes
visible what an expert computes in their head and a novice never learns.

**The Problems overlay and the chief advisor.** A single ⚠ button in the top bar counts
everything currently at fault and, tapped, desaturates the city and paints every fault in
one alert colour. The Advisors button opens on the chief advisor, which ranks the same
list worst first — debt, famine, fire, invasion, labour, unrest, a god's anger, a stalled
monument, a building with no road, a bazaar with nothing to sell — and puts every entry one
tap from the place it went wrong. Both read the same `cityProblems()` call, so the map and
the panel can never disagree.

**Named stalls.** A stalled monument says which of the five things is missing: no source of
the material, none reaching the site, no labourers, no guild, or workers outbid elsewhere.
An empty venue says which school never sent it a performer.

**Numbers and bands, with direction.** The Nilometer reads `40% ▲ good` and the sentiment
chip reads `62 ▼ content`, with the dominant cause named beneath it in the advisor. A novice
reads the band, an expert reads the number, and both get the trend.

**While you were away.** Resuming a city opens on a card summarising what changed over the
stretch you were not watching: population and treasury deltas, buildings lost, monuments
advanced, requests outstanding, and the three things most wrong right now. Available again
any time from the message log.

---

## Running it on your iPhone

**Live: https://dannygway.github.io/pharoah-mobile/**

Open that in Safari, then **Share → Add to Home Screen**. You get a real app icon that
launches fullscreen with no Safari chrome, clears the Dynamic Island, and runs with the
network off — the service worker precaches the whole build on first visit.

Every push to `main` rebuilds and redeploys it via `.github/workflows/deploy.yml`.

The rest of this section covers running it yourself.

### Option A — from your Mac or PC on the same Wi-Fi (fastest)

```bash
npm install
npm run build
npm run preview        # prints a Network: http://192.168.x.x:4173 URL
```

On the iPhone, open that Network URL in Safari, then **Share → Add to Home Screen**.
Launch it from the icon. It will now work with the network off.

> It must be `http://<LAN-IP>` or HTTPS — service workers do not register on
> `file://`, so opening the HTML directly will work but will not install offline.

### Option B — host it anywhere static (this is what the live URL does)

`dist/` is entirely static and uses relative paths, so it works from a subdirectory.

```bash
npm run build
# then push dist/ to GitHub Pages, Netlify, Cloudflare Pages, a VPS — anywhere
```

Open the URL in Safari → **Share → Add to Home Screen**.

### Option C — a real native app (needs a Mac + Xcode)

The web build is the source of truth; Capacitor wraps it in a native shell so you can
sideload it with a free Apple ID.

```bash
npm run build
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap add ios
npx cap sync ios
npx cap open ios        # builds in Xcode; select your device and press Run
```

`capacitor.config.json` is already committed. A free provisioning profile lasts seven days
before it needs re-signing; a paid developer account lasts a year.

---

## Controls

| Gesture | Not building | Building armed |
| --- | --- | --- |
| One finger drag | Pan the map (with momentum) | Position / paint |
| Two finger drag | Pan | Pan |
| Pinch | Zoom about the midpoint | Zoom |
| Tap | Select a building | — |
| Lift finger | — | Place |
| Press and hold | Full building details | Full building details |

A mis-tap on glass is common in a way a mis-click never was, so placement and demolition
each offer a single level of **undo** from a toast for five seconds afterwards. It is not a
timeline rewind: a restored building comes back empty, without its residents or its stock.

Roads, walls, gardens and housing drag out in a run — roads snap to an L-shape from where
you started, which is far easier to control with a thumb than a freehand trail.

---

## Development

```bash
npm install
npm run dev          # vite dev server on :5173, host-exposed for device testing
npm run typecheck    # tsc --noEmit
npm run build        # icons + vite build + service-worker precache manifest
npm run smoke        # headless browser test: boots, builds a city, runs it, asserts
npm run standalone   # fold the whole build into one self-contained index.html
```

`npm run smoke` is the real safety net. It serves the production build to a headless
Chromium at iPhone dimensions, builds a working district programmatically, runs several
simulated years, and asserts that people arrive, walkers spawn, services reach houses,
housing evolves, food reaches households, and save/load round-trips — then exercises the
diagnostic UI (status strip, chief advisor, reachability halo, storage orders) and writes
`smoke-city.png` so you can look at it.

When the ladder stalls it prints why: the blocker distribution per housing level, the
ranked fault list, and the state of every link in the food chain. A bare "never got past
level 2" sends the next reader hunting through the simulation for a bug that may not be
there.

### Layout

| File | What lives there |
| --- | --- |
| `src/core.ts` | Seeded RNG, noise, math, event bus |
| `src/consts.ts` | Timing: ticks per month, days per month, service decay window |
| `src/data.ts` | Goods, gods, the 20-level housing ladder, the building catalogue |
| `src/world.ts` | Terrain generation, the river, tile state, road pathfinding |
| `src/sim.ts` | The city: buildings, labour, production, housing evolution, the tick |
| `src/walkers.ts` | The walker system — roaming service, carts, buyers, immigrants, combat |
| `src/systems.ts` | Logistics, monuments, religion, trade, war, disasters, ratings, diagnosis |
| `src/atlas.ts` | Every sprite in the game, drawn procedurally at boot |
| `src/gl.ts` | WebGL2 instanced sprite batcher — one texture, one draw call |
| `src/scene.ts` | Isometric camera, painter's-order draw pass, overlays, reachability halo |
| `src/input.ts` | Touch gesture grammar |
| `src/audio.ts` | Procedural ambience, generative score, effects |
| `src/ui.ts` | HUD, build menu, advisors, panels, minimap, storage orders |
| `src/game.ts` | Loop, build interaction, mission goals, saving |
| `src/missions.ts` | The campaign |

### Performance notes

The things that matter on a phone, and what was done about them:

- **One draw call per frame.** Every sprite is an instance in a single interleaved
  `Float32Array` uploaded once and drawn with `drawArraysInstanced`. Instances rasterise
  in submission order, so painter's-order submission gives correct isometric occlusion
  with no depth buffer and no sorting by the GPU.
- **No per-frame sorting.** Objects are bucketed by isometric diagonal (`x + y`), which is
  linear and allocation-free, instead of being sorted every frame.
- **Fixed-timestep simulation** decoupled from the display, capped so a stall dilates time
  rather than triggering a death spiral. The renderer draws every frame regardless.
- **Flat typed arrays** for all per-tile state, so the whole map is a handful of
  contiguous buffers.
- **Stamped BFS scratch buffers** — road pathfinding allocates nothing and clears nothing
  between calls.
- **Backing store capped at 3× DPR**; above that there is no visible gain and real
  thermal cost.
- **Simulation and audio suspend** when the app is backgrounded, and the city autosaves.

---

## About the name

This is an original game. It is not *Pharaoh*, *Pharaoh: A New Era*, or any other
product of Impressions Games, Sierra, Triskell Interactive or Dotemu, and it contains
none of their code, art, audio, text or trademarks. It is an independent implementation
of a genre those games defined, with all assets generated from the source in this
repository.

## Licence

MIT — see `LICENSE`.
