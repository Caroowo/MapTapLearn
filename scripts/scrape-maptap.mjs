/**
 * Scrapes https://maptap.gg/locations into the same dataset shape the game reads.
 *
 *   node scripts/scrape-maptap.mjs                 # scrape + write data/
 *   node scripts/scrape-maptap.mjs --dump          # only save the raw payloads
 *   node scripts/scrape-maptap.mjs --url <url>     # scrape a different endpoint
 *
 * The page's exact markup is not pinned down here, so the scraper tries, in
 * order: known JSON endpoints, JSON embedded in the HTML (Next.js/Nuxt/JSON-LD
 * or any inline array of location-shaped objects), an HTML table, and finally
 * the location-shaped JS assets the page pulls in (maptap.gg keeps its atlas in
 * data/master_locations_v2.js, a plain `const masterLocationsV2 = [...]`).
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
  `${ORIGIN}/data/master_locations_v2.js`,
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

/** Folds spelling variants together: "St. Kitts & Nevis" === "Saint Kitts and Nevis". */
function foldCountryName(value) {
  return value
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bst\.?\b/g, 'saint')
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Names Intl spells differently enough that folding cannot bridge the gap, plus
 * the UK's constituent countries, which maptap.gg lists in place of "United Kingdom".
 */
const COUNTRY_ALIASES = new Map(Object.entries({
  england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  'great britain': 'GB', uk: 'GB', usa: 'US', 'united states of america': 'US',
  'democratic republic of congo': 'CD', 'dr congo': 'CD', 'republic of congo': 'CG',
  myanmar: 'MM', burma: 'MM', palestine: 'PS', 'east timor': 'TL',
  'georgia country': 'GE', 'federated states of micronesia': 'FM',
  'turks and caicos': 'TC', 'south georgia': 'GS', 'midway atoll': 'UM',
  saba: 'BQ', 'sint eustatius': 'BQ', bonaire: 'BQ', 'ivory coast': 'CI',
  'cape verde': 'CV', swaziland: 'SZ', macedonia: 'MK', vatican: 'VA',
}));

const nameToCode = (() => {
  const map = new Map();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        // Deprecated codes resolve to their successor's name (SU → "Russia",
        // FX → "France"); keep only codes that are their own canonical form.
        if (new Intl.Locale(`und-${code}`).region !== code) continue;
        const name = COUNTRY_CODES.of(code);
        if (name && name !== code) map.set(foldCountryName(name), code);
      } catch { /* not a region code */ }
    }
  }
  for (const [alias, code] of COUNTRY_ALIASES) map.set(foldCountryName(alias), code);
  return map;
})();

function toCountryCode(value) {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  // Border-straddling entries ("Nepal/China", "Argentina/Chile") belong to no
  // single country, and this game asks you to place a pin inside one.
  if (trimmed.includes('/')) return null;
  return nameToCode.get(foldCountryName(trimmed)) ?? null;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace(/[\s,'’]/g, '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * maptap.gg labels places "Aarhus, Denmark" or "Akron, Ohio, USA" — the country
 * is the answer here, so leaving it in the prompt gives the round away. Only
 * country segments go; "Akron, Ohio" keeps the state that tells it apart from
 * the other Akrons.
 */
function stripCountrySuffix(label, code) {
  const parts = label.split(',');
  while (parts.length > 1 && toCountryCode(parts[parts.length - 1].trim()) === code) {
    parts.pop();
  }
  return parts.join(',').trim() || label;
}

/** @returns {{name,lat,lon,pop,country}|null} */
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const flat = { ...raw, ...(raw.properties ?? {}), ...(raw.attributes ?? {}) };

  // maptap.gg ships retired entries in the same pool, flagged rather than removed.
  if (flat.disabled === true || flat.enabled === false) return null;

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
    name: stripCountrySuffix(name.trim(), country),
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

/**
 * Reads a literal out of a plain JS file (`const masterLocationsV2 = [{...}]`).
 * Bracket-counting rather than a regex, so the `];` inside a string value or a
 * nested array cannot cut the literal short.
 */
function jsonLiteralsFromJs(text) {
  const found = [];
  for (const match of text.matchAll(/(?:const|let|var)\s+[\w$]+\s*=\s*|(?:window|globalThis|module\.exports|exports\.[\w$]+)\s*=\s*/g)) {
    const start = match.index + match[0].length;
    const open = text[start];
    if (open !== '[' && open !== '{') continue;
    const close = open === '[' ? ']' : '}';

    let depth = 0;
    let quote = null;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          found.push(JSON.parse(text.slice(start, i + 1)));
        } catch { /* JS object literal, not JSON — skip */ }
        break;
      }
    }
  }
  return found;
}

/** The `<script src>` assets whose URL hints they carry the location data. */
function locationAssetUrls(html, baseUrl) {
  const urls = new Set();
  for (const [, src] of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    if (!/location|places|cities|atlas|master/i.test(src)) continue;
    try {
      urls.add(new URL(src, baseUrl).href);
    } catch { /* unresolvable src */ }
  }
  return [...urls];
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

/** Runs every extraction strategy over one response body. */
function extract(body, type = '') {
  let found = [];
  if (type.includes('json') || /^\s*[[{]/.test(body)) {
    try {
      found = harvest(JSON.parse(body));
    } catch { /* fall through to the text-based strategies */ }
  }
  if (!found.length) {
    for (const blob of jsonBlobsFromHtml(body)) {
      found.push(...harvest(blob));
      if (found.length) break;
    }
  }
  if (!found.length) {
    for (const literal of jsonLiteralsFromJs(body)) {
      found.push(...harvest(literal));
      if (found.length) break;
    }
  }
  if (!found.length) found = locationsFromHtmlTable(body);
  return found;
}

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

    const found = extract(res.body, res.type);
    attempts.push(`${url} → HTTP ${res.status}, ${found.length} locations (raw saved to ${path.relative(ROOT, file)})`);
    if (found.length) return { url, found, attempts };

    // Nothing inline: the page may just be a shell that loads its atlas as a
    // separate script (maptap.gg does exactly this).
    for (const assetUrl of locationAssetUrls(res.body, url)) {
      let asset;
      try {
        asset = await get(assetUrl);
      } catch (err) {
        attempts.push(`  ↳ ${assetUrl} → network error: ${err.message}`);
        continue;
      }
      if (!asset.ok) {
        attempts.push(`  ↳ ${assetUrl} → HTTP ${asset.status}`);
        continue;
      }
      const assetFile = path.join(RAW_DIR, `${assetUrl.replace(/[^a-z0-9]+/gi, '_').slice(-80)}.txt`);
      await writeFile(assetFile, asset.body);
      const hits = extract(asset.body, asset.type);
      attempts.push(`  ↳ ${assetUrl} → HTTP ${asset.status}, ${hits.length} locations (raw saved to ${path.relative(ROOT, assetFile)})`);
      if (hits.length) return { url: assetUrl, found: hits, attempts };
    }
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
