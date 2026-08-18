/**
 * Builds the bootstrap dataset used by MapTap Learn.
 *
 * Source: GeoNames (via the `all-the-cities` npm package), which carries the
 * three fields the game needs: name, lat/lon and population.
 *
 * Run `npm run scrape` instead once maptap.gg is reachable — it writes the same
 * on-disk shape from MapTap's own location list.
 *
 *   Usage: npm install && npm run build:data
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDataset, round } from './lib/emit.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cities = require('all-the-cities');
const byCountry = new Map();

for (const city of cities) {
  if (!city.population || city.population <= 0) continue;
  const list = byCountry.get(city.country) ?? [];
  list.push({
    name: city.name,
    lat: round(city.loc.coordinates[1], 4),
    lon: round(city.loc.coordinates[0], 4),
    pop: city.population,
  });
  byCountry.set(city.country, list);
}

await emitDataset(byCountry, {
  outDir: path.join(ROOT, 'data'),
  source: 'geonames',
  sourceLabel: 'GeoNames (bootstrap dataset)',
});
