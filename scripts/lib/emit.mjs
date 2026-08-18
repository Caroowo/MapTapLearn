/** Shared writer: turns normalized locations into the on-disk dataset. */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

// A guard rail against one country pulling a huge file, not a curation step:
// keep it above the largest country in either source, or the tail — which is
// where the population-less landmarks sort — gets silently deleted.
export const MAX_PER_COUNTRY = 700;
export const MIN_PER_COUNTRY = 6;

const displayName = new Intl.DisplayNames(['en'], { type: 'region' });

export function countryName(code) {
  try {
    const name = displayName.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

export function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function bbox(locations) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const { lat, lon } of locations) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [round(minLat, 3), round(minLon, 3), round(maxLat, 3), round(maxLon, 3)];
}

/** Drops duplicate place names within a country, keeping the most populous. */
export function dedupe(locations) {
  const seen = new Map();
  for (const loc of locations) {
    const key = loc.name.toLowerCase();
    const kept = seen.get(key);
    if (!kept || loc.pop > kept.pop) seen.set(key, loc);
  }
  return [...seen.values()];
}

/**
 * @param {Map<string, Array<{name:string,lat:number,lon:number,pop:number}>>} byCountry
 * @param {{outDir:string, source:string, sourceLabel:string, maxPerCountry?:number}} options
 */
export async function emitDataset(byCountry, options) {
  const { outDir, source, sourceLabel, maxPerCountry = MAX_PER_COUNTRY } = options;
  await rm(path.join(outDir, 'countries'), { recursive: true, force: true });
  await mkdir(path.join(outDir, 'countries'), { recursive: true });

  const index = [];
  for (const [code, raw] of byCountry) {
    const name = countryName(code);
    if (!name) continue;

    const locations = dedupe(raw)
      .sort((a, b) => b.pop - a.pop)
      .slice(0, maxPerCountry);
    if (locations.length < MIN_PER_COUNTRY) continue;

    const box = bbox(locations);
    await writeFile(
      path.join(outDir, 'countries', `${code}.json`),
      JSON.stringify({ code, name, bbox: box, locations }),
    );
    index.push({ code, name, count: locations.length, bbox: box });
  }

  index.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(
    path.join(outDir, 'index.json'),
    JSON.stringify({
      source,
      sourceLabel,
      generated: new Date().toISOString().slice(0, 10),
      countries: index,
    }),
  );

  const total = index.reduce((sum, c) => sum + c.count, 0);
  console.log(`Wrote ${index.length} countries / ${total} locations to ${outDir}`);
  return { countries: index.length, locations: total };
}
