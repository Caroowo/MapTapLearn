# MapTap Learn

A map learning game for [maptap.gg](https://maptap.gg). Pick a country, get shown
one of its places, drop a pin on a satellite world map, and get scored 1–100 on
how close you were — with both pins revealed side by side.

Plain static site: no build step, no framework, no API keys. It runs from any
static host, including GitHub Pages.

## Play

1. **Pick a country** — search the list; the number is how many places it has.
2. **Pick a difficulty** — this decides the pool of places you can be asked about:
   | Difficulty | Pool |
   | --- | --- |
   | Easy | the 10 most populous places |
   | Medium | the most populous half |
   | Hard | every place in the country |
   Places are ordered by population, so easy asks about the ones you are most
   likely to know and hard reaches into small towns.
3. **Pick a round count** (5 / 10 / 20) and play. Click the map to place your
   pin, click again to adjust, then confirm. `Enter` or `Space` also confirms
   and advances.

### Scoring

Each round scores `100 · e^(−4 · distance / countrySize)`, clamped to 1–100,
where `countrySize` is the diagonal of the country's bounding box. Scoring
relative to the country's own size is what keeps Luxembourg and Russia
comparably hard — being 50 km off matters a lot more in one than the other.
Dead on is 100, a quarter of the country away is about 37, half the country
away about 14.

## Map

Esri **World Imagery** satellite tiles (free, no key, no sign-up) rendered with
[Leaflet](https://leafletjs.com), which is vendored under `vendor/leaflet/` so
the game has no CDN dependency at runtime. Zoom is capped at z17 and no label
layer is drawn, so the answer is never simply readable off the basemap.

## Data

The game reads a small dataset split per country:

```
data/index.json            # country list: code, name, place count, bounding box
data/countries/DE.json     # { code, name, bbox, locations: [{ name, lat, lon, pop }] }
```

Locations are sorted by population descending (that ordering *is* the difficulty
mechanic) and capped at 300 per country so no round pulls a large file.

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
assets/js/data.js       dataset loading, difficulty pools, round draw
assets/js/scoring.js    great-circle distance, 1–100 score
assets/js/mapview.js    Leaflet wrapper: basemap, pins, reveal
scripts/build-dataset.mjs   GeoNames → data/
scripts/scrape-maptap.mjs   maptap.gg → data/
scripts/lib/emit.mjs        shared dataset writer
```
