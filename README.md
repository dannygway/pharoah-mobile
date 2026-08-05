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

**Housing.** Twenty levels, from a crude hut to a palatial estate. Each rung demands more:
water, a second food type, pottery, a god, a school, entertainment, medicine, linen, beer,
jewellery, plus a desirability floor. Select any house and it tells you exactly what is
blocking it. Houses devolve the moment a requirement lapses.

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

## Running it on your iPhone

The game is a PWA. Once it is on your home screen it runs fullscreen, offline, with no
Safari chrome and no App Store involved.

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

### Option B — host it anywhere static

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
```

`npm run smoke` is the real safety net. It serves the production build to a headless
Chromium at iPhone dimensions, builds a working district programmatically, runs several
simulated years, and asserts that people arrive, walkers spawn, services reach houses,
housing evolves, food reaches households, and save/load round-trips — then writes
`smoke-city.png` so you can look at it.

### Layout

| File | What lives there |
| --- | --- |
| `src/core.ts` | Seeded RNG, noise, math, event bus |
| `src/data.ts` | Goods, gods, the 20-level housing ladder, the building catalogue |
| `src/world.ts` | Terrain generation, the river, tile state, road pathfinding |
| `src/sim.ts` | The city: buildings, labour, production, housing evolution, the tick |
| `src/walkers.ts` | The walker system — roaming service, carts, buyers, immigrants, combat |
| `src/systems.ts` | Logistics, monuments, religion, trade, war, disasters, ratings |
| `src/atlas.ts` | Every sprite in the game, drawn procedurally at boot |
| `src/gl.ts` | WebGL2 instanced sprite batcher — one texture, one draw call |
| `src/scene.ts` | Isometric camera, painter's-order draw pass, data overlays |
| `src/input.ts` | Touch gesture grammar |
| `src/audio.ts` | Procedural ambience, generative score, effects |
| `src/ui.ts` | HUD, build menu, advisors, panels, minimap |
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
