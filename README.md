# MapTap Learn

A map learning game for [maptap.gg](https://maptap.gg). Pick a country, get shown
one of its places, drop a pin on a satellite world map, and get scored 1–100 on
how close you were — with both pins revealed side by side.

Plain static site: no build step, no framework, no API keys. It runs from any
static host, including GitHub Pages.

## Play

1. **Pick a country** — search the list; the number is how many places it has.
2. **Pick a difficulty** — that is the whole setup. A game asks about every
   place in the pool, in a random order:
   | Difficulty | Pool | Germany (97 places) |
   | --- | --- | --- |
   | Easy | the 5 most populous places | 5 rounds |
   | Medium | the most populous half | 49 rounds |
   | Hard | every place in the country | 97 rounds |
   Places are ordered by population, so easy asks about the ones you are most
   likely to know and hard reaches into small towns. The pool is fixed and only
   its order is shuffled, so two runs of a setup are comparable and a personal
   best is a target you can actually chase.

   A country too small for the ladder drops a tier rather than offering two
   buttons that play alike: with 10 places the top half is also 5 places, so
   **Easy** disappears and Medium is the easiest game. 39 of the 127 countries
   are in that position.
3. **Optionally shorten it.** The slider under the difficulty runs from 1 to the
   pool size and starts at the full pool. Pull it down for a quick run — 25 of
   Germany's 97, say — and the game plays a random slice of the pool instead of
   all of it. Picking a different country or difficulty snaps it back to full.

   A shortened run is **practice and is not scored**: it plays a random slice, so
   two of them are not the same game and neither is comparable to the full pool.
   Personal bests only come from playing a whole pool.
4. **Play.** One click on the map is the guess — it drops the pin and scores it
   at once, with no confirm step. `Enter` or `Space` moves on to the next round.

### Scoring

Anything within **15 km counts as dead on** and scores 100. Landing that close
means you knew where the place was, and which pixel inside the city you happened
to hit should not be what decides the round. It is a flat radius rather than one
scaled to the country: the smallest country in the dataset is ~153 km across, so
15 km is at most a tenth of any yardstick.

Past that radius, each round scores `100 · e^(−4 · (distance − 15 km) /
yardstick)`, clamped to 1–100. Measuring from the edge of the perfect radius
rather than from the target means the score eases out of 100 instead of stepping
off it — on a 800 km yardstick, 20 km is 98 and 30 km is 94.

### The yardstick

Two things it is deliberately not. Scoring purely on absolute distance would make
small countries trivial and huge ones hopeless: 100 km off is a rounding error in
Russia and the whole country in Lebanon. Scoring purely against a country's own
size — the original approach here — makes the same miss mean wildly different
things, and breaks outright on the countries whose bounding box is set by a
territory thousands of km away. France's box reaches the Kerguelen Islands, which
scored a **1,000 km miss in Paris as 78 out of 100**.

So the yardstick is built in two steps:

1. **From the places, not the box.** Take the median centre of the country's
   locations, the distance covering 85% of them, and double it. Medians and a
   percentile rather than extremes, so Kerguelen, Svalbard, the Azores and Hawaii
   cannot stretch a country. Longitudes are averaged on the circle, or a country
   straddling the antimeridian would land its centre on the far side of the
   planet.
2. **Halfway back to a general scale.** The result is the geometric mean of that
   spread and a fixed 1,000 km, which halves how much the country matters without
   flattening it away. Across the 127 countries this pulls the yardsticks from a
   109× spread (153 km–16,649 km) down to 7× (338 km–2,522 km).

What changes in practice:

| | 50 km miss | 300 km miss |
| --- | --- | --- |
| Israel | 32 → **69** | 1 → 5 |
| Germany | 81 → **84** | 29 → 25 |
| France | 99 → **87** | 93 → **33** |
| United States | 98 → **94** | 87 → **58** |
| Russia | 95 → 95 | 72 → 64 |

Small countries get more forgiving, the broken ones get honest, and a miss of a
given size now means something closer to the same thing everywhere.

## Map

Esri **World Imagery** satellite tiles (free, no key, no sign-up) rendered with
[Leaflet](https://leafletjs.com), which is vendored under `vendor/leaflet/` so
the game has no CDN dependency at runtime. Zoom is capped at z17 and no label
layer is drawn, so the answer is never simply readable off the basemap.

### Borders

The **Borders** button on the map toggles administrative boundaries: country
lines solid and legible, state and province lines thinner, fainter and dashed so
they read as background. Both are line-only and carry no names — a label layer
would hand over the answer the round is asking for.

The two layers are ~1.2 MB together, so they are fetched the first time the
button is pressed rather than on every page load, and kept for the session. They
draw on a canvas renderer: the state layer is ~19k polylines, which as SVG nodes
would stall every pan.

## Data

The game reads a small dataset split per country:

```
data/index.json            # country list: code, name, place count, bounding box
data/countries/DE.json     # { code, name, bbox, locations: [{ name, lat, lon, pop }] }
data/borders/*.json        # MultiLineString overlays for the Borders button
```

Each country carries two boxes: `bbox` is its true extent, and `view` is what the
map frames a round on. They differ for the same reason the yardstick needed
fixing — framing France's real extent opens the round on half a hemisphere with
the country a speck in the corner, so `view` drops the outlying 15% of places.
Everything is still reachable by panning; it is a starting view, not a boundary.

Locations are sorted by population descending (that ordering *is* the difficulty
mechanic — the app never re-sorts, it slices) and capped at 700 per country so no
round pulls a large file. The cap
is a guard rail rather than curation — places with no population sort last, so a
cap tighter than the biggest country deletes landmarks (at 300 the US lost
Alcatraz, China the Forbidden City and Everest) rather than trimming filler.

### Sources

**Currently shipped:** MapTap's own atlas — 126 countries, 4,630 places, scraped
from `maptap.gg`. The site's `/locations` page is a shell that loads its pool from
`data/master_locations_v2.js` (a plain `const masterLocationsV2 = [...]`, 7,920
entries of which 5,443 are active); the scraper reads that.

```bash
npm install
npm run scrape                       # scrape maptap.gg/locations → data/
npm run scrape -- --dump             # inspect what it finds first, write nothing
npm run scrape -- --url <endpoint>   # point it at a specific page or endpoint
```

`scripts/scrape-maptap.mjs` tries known JSON endpoints, then JSON embedded in the
page (Next.js/Nuxt/JSON-LD or any inline array of location-shaped objects), then
an HTML table, and finally the `<script src>` assets whose URL hints they carry
locations — so if MapTap renames or re-versions the data file, the page still
leads the scraper to it. Records are normalized by sniffing field names
(`lat`/`latitude`/`y`, `lng`/`lon`, `pop`/`population`, …); entries MapTap flags
`disabled` are skipped, country names are folded onto ISO codes (`England` → `GB`,
`Côte d'Ivoire` → `CI`), border-straddling entries like `Nepal/China` are dropped
since a round has exactly one right country, and the country is trimmed off labels
(`Akron, Ohio, USA` → `Akron, Ohio`) so the prompt doesn't give the answer away.
If nothing matches it saves the raw responses to `data/raw/` and says so — extend
the `KEYS` map in that script to fit.

**The GeoNames bootstrap** is still available and covers more countries (211,
~24,800 places), since MapTap's pool thins out below the 6-locations-per-country
floor for about 100 small states and territories:

```bash
npm run build:data     # regenerate from GeoNames instead
```

Both scripts write the identical on-disk shape, so swapping sources needs no app
changes; the menu footer shows which source is loaded.

### Borders

```bash
npm run build:borders   # Natural Earth → data/borders/
```

Country lines come from Natural Earth 1:50m; state lines have to come from 1:10m,
because the 1:50m admin-1 file only covers 28 of the 127 countries here — no
German states, no French regions. That file is 6.4 MB of far more detail than a
faint overlay needs, so the script simplifies it (Douglas–Peucker, ~3 km) and
drops fragments spanning under ~11 km, which gets it to 959 KB with all 127
countries still covered. Names and every other property are stripped.

## Scores

Finishing a game files a personal best in `localStorage`, under
`maptap-learn.records.v3`. Nothing leaves the browser and there is no account.

Only a full run of a pool is scored; the round slider is practice (see **Play**
above). A best belongs to a *setup* — country and difficulty — because that is
what makes two scores comparable: a setup always asks about the same places, so
beating your best means beating it on the same questions. A tie does not
overwrite a standing best.

The key carries a version for that reason: when what a setup plays changes, the
bests scored against the old one are not records anyone can chase, so the version
moves and they start over rather than standing as targets set on a different
game.

Bests show up in three places: a ★ badge in the country list (that country's best
across every setup), a line under the menu summary (the best for the exact setup
selected), and the end-of-game panel, which says whether the run beat it.

Storage is best-effort. Reading or writing `localStorage` throws outright in some
browsers — private mode, cookies disabled, a `file://` page under a strict policy
— so every access is guarded and a failure degrades to bests held in memory for
the session; the summary says so rather than the game breaking. `clearRecords()`
in `assets/js/records.js` wipes them.

## Run locally

```bash
npm run serve          # http://localhost:8080
```

Any static server works — it must be served over HTTP, not opened as a `file://`
URL, because the app uses ES modules and `fetch`.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` publishes the repo root on every push to `main`.
Enable it once under **Settings → Pages → Source → GitHub Actions**. `.nojekyll`
is committed so Jekyll doesn't touch the files.

## Roadmap

The mode switcher in the menu is wired for more modes; only **Countries** is
implemented. Capitals and a world-wide mode are the obvious next two, and both
fit the existing round loop — they only need a different pool builder in
`assets/js/data.js`.

## Layout

```
index.html              markup for menu, HUD, result and summary
assets/js/main.js       menu, game loop, result reporting
assets/js/records.js    personal bests in localStorage
assets/js/data.js       dataset loading, difficulty pools, round draw
assets/js/scoring.js    great-circle distance, 1–100 score
assets/js/mapview.js    Leaflet wrapper: basemap, pins, reveal
scripts/build-borders.mjs   Natural Earth → data/borders/
scripts/build-dataset.mjs   GeoNames → data/
scripts/scrape-maptap.mjs   maptap.gg → data/
scripts/lib/emit.mjs        shared dataset writer
```
