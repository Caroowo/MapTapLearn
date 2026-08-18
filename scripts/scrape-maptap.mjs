/**
 * Scrapes https://maptap.gg/locations into the same dataset shape the game reads.
 *
 *   node scripts/scrape-maptap.mjs                 # scrape + write data/
 *   node scripts/scrape-maptap.mjs --dump          # only save the raw payloads
 *   node scripts/scrape-maptap.mjs --url <url>     # scrape a different endpoint
 *
 * The page's exact markup is not pinned down here, so the scraper tries, in
 * order: known JSON endpoints, JSON embedded in the HTML (Next.js/Nuxt/JSON-LD
 * or any inline array of location-shaped objects), and finally an HTML table.
 * Whatever it finds is normalized by field-name sniffing, so renamed keys
 * (`latitude`/`lat`/`y`, `pop`/`population`/`inhabitants`, …) still land.
 * If every strategy misses it dumps the raw response to data/raw/ and says so.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDataset, round } from './lib/emit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');

const args = process.argv.slice(2);
const dumpOnly = args.includes('--dump');
const urlFlag = args.indexOf('--url');
const PAGE_URL = urlFlag >= 0 ? args[urlFlag + 1] : 'https://maptap.gg/locations';
const ORIGIN = new URL(PAGE_URL).origin;

const API_CANDIDATES = [
  `${ORIGIN}/api/locations`,
  `${ORIGIN}/locations.json`,
  `${ORIGIN}/api/v1/locations`,
  `${ORIGIN}/data/locations.json`,
];

const HEADERS = {
  'user-agent': 'maptap-learn-dataset-builder/0.1 (+https://github.com/Caroowo/MapTapLearn)',
  accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
};

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  return { ok: res.ok, status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

/* ------------------------------------------------- field-name sniffing */

const KEYS = {
  name: ['name', 'title', 'city', 'place', 'location', 'label'],
  lat: ['lat', 'latitude', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  pop: ['pop', 'population', 'inhabitants', 'people', 'residents'],
  country: ['country', 'countrycode', 'country_code', 'countryCode', 'iso', 'iso2', 'cc', 'nation'],
};

function pick(obj, names) {
  for (const key of Object.keys(obj)) {
    if (names.includes(key.toLowerCase().replace(/[\s_-]/g, ''))
        || names.includes(key.toLowerCase())) {
      return obj[key];
    }
  }
  return undefined;
}

const COUNTRY_CODES = new Intl.DisplayNames(['en'], { type: 'region' });
const nameToCode = (() => {
  const map = new Map();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const name = COUNTRY_CODES.of(code);
        if (name && name !== code) map.set(name.toLowerCase(), code);
      } catch { /* not a region code */ }
    }
  }
  return map;
})();

function toCountryCode(value) {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return nameToCode.get(trimmed.toLowerCase()) ?? null;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/[\s,'’]/g, '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** @returns {{name,lat,lon,pop,country}|null} */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const flat = { ...raw, ...(raw.properties ?? {}), ...(raw.attributes ?? {}) };

  let lat = toNumber(pick(flat, KEYS.lat));
  let lon = toNumber(pick(flat, KEYS.lon));
  // GeoJSON-ish: coordinates are [lon, lat]
  const coords = flat.coordinates ?? flat.loc?.coordinates ?? flat.geometry?.coordinates;
  if ((lat === null || lon === null) && Array.isArray(coords) && coords.length >= 2) {
    lon = toNumber(coords[0]);
    lat = toNumber(coords[1]);
  }
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const name = pick(flat, KEYS.name);
  if (typeof name !== 'string' || !name.trim()) return null;

  const country = toCountryCode(pick(flat, KEYS.country));
  if (!country) return null;

  const pop = toNumber(pick(flat, KEYS.pop));
  return {
    name: name.trim(),
    lat: round(lat, 4),
    lon: round(lon, 4),
    // No population on a record means "least relevant", not "excluded".
    pop: pop && pop > 0 ? Math.round(pop) : 1,
    country,
  };
}

/** Walks any JSON blob and collects everything that looks like a location. */
function harvest(value, found = [], depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return found;
  const hit = normalize(value);
  if (hit) {
    found.push(hit);
    return found;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    harvest(child, found, depth + 1);
  }
  return found;
}

/* ------------------------------------------------- extraction strategies */

function jsonBlobsFromHtml(html) {
  const blobs = [];
  const scripts = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, body] of scripts) {
    const text = body.trim();
    if (!text) continue;
    for (const candidate of [text, ...text.matchAll(/(\[[\s\S]{200,}?\])\s*[;,)]/g)].flat()) {
      const source = typeof candidate === 'string' ? candidate : candidate[1];
      if (!source || !/[[{]/.test(source)) continue;
      const start = source.search(/[[{]/);
      try {
        blobs.push(JSON.parse(source.slice(start)));
      } catch { /* not standalone JSON */ }
    }
  }
  return blobs;
}

function locationsFromHtmlTable(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (rows.length < 2) return [];

  const cells = (row) =>
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map(([, c]) => c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim());

  const header = cells(rows[0][1]).map((h) => h.toLowerCase());
  if (!header.length) return [];

  const found = [];
  for (const row of rows.slice(1)) {
    const values = cells(row[1]);
    if (values.length !== header.length) continue;
    found.push(normalize(Object.fromEntries(header.map((h, i) => [h, values[i]]))));
  }
  return found.filter(Boolean);
}

/* ------------------------------------------------- main */

async function collect() {
  await mkdir(RAW_DIR, { recursive: true });
  const attempts = [];

  for (const url of [...API_CANDIDATES, PAGE_URL]) {
    let res;
    try {
      res = await get(url);
    } catch (err) {
      attempts.push(`${url} → network error: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      attempts.push(`${url} → HTTP ${res.status}`);
      continue;
    }

    const file = path.join(RAW_DIR, `${url.replace(/[^a-z0-9]+/gi, '_').slice(-80)}.txt`);
    await writeFile(file, res.body);

    let found = [];
    if (res.type.includes('json') || /^\s*[[{]/.test(res.body)) {
      try {
        found = harvest(JSON.parse(res.body));
      } catch { /* fall through to HTML handling */ }
    }
    if (!found.length) {
      for (const blob of jsonBlobsFromHtml(res.body)) {
        found.push(...harvest(blob));
        if (found.length) break;
      }
    }
    if (!found.length) found = locationsFromHtmlTable(res.body);

    attempts.push(`${url} → HTTP ${res.status}, ${found.length} locations (raw saved to ${path.relative(ROOT, file)})`);
    if (found.length) return { url, found, attempts };
  }
  return { url: null, found: [], attempts };
}

const { url, found, attempts } = await collect();
console.log(attempts.map((line) => `  ${line}`).join('\n'));

if (!found.length) {
  console.error(
    '\nNo locations extracted. The raw responses are in data/raw/ — inspect them and\n' +
    'either point --url at the real JSON endpoint or extend the KEYS map in this script.\n' +
    'If maptap.gg is unreachable from here, run this on a machine that can reach it.',
  );
  process.exit(1);
}

// Dedupe across the whole scrape: the same place can appear in several lists.
const seen = new Set();
const byCountry = new Map();
for (const loc of found) {
  const key = `${loc.country}|${loc.name.toLowerCase()}|${loc.lat}|${loc.lon}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const list = byCountry.get(loc.country) ?? [];
  list.push({ name: loc.name, lat: loc.lat, lon: loc.lon, pop: loc.pop });
  byCountry.set(loc.country, list);
}

console.log(`\nScraped ${found.length} records from ${url} (${byCountry.size} countries).`);

if (dumpOnly) {
  const file = path.join(RAW_DIR, 'locations.normalized.json');
  await writeFile(file, JSON.stringify(found, null, 2));
  console.log(`--dump: normalized records written to ${path.relative(ROOT, file)} (data/ untouched)`);
  process.exit(0);
}

await emitDataset(byCountry, {
  outDir: path.join(ROOT, 'data'),
  source: 'maptap',
  sourceLabel: 'maptap.gg/locations',
});
