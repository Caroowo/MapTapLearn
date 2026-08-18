/**
 * Builds the border overlays the map's Borders button draws.
 *
 *   node scripts/build-borders.mjs
 *
 * Source is Natural Earth (public domain), boundary *lines* — not filled country
 * polygons. Lines are what the game wants: the basemap is satellite imagery, so
 * coastlines are already visible and only the invisible borders need drawing,
 * and a line layer is a fraction of the size of the polygons.
 *
 * Deliberately no labels or names anywhere: a round asks you to find a place, so
 * an overlay that writes place names on the map would hand over the answer.
 * Properties are dropped entirely — the game never asks which border it is.
 *
 * The two layers come from different scales on purpose. Natural Earth's 1:50m
 * admin-1 file only covers 28 of the 127 countries in the dataset (no German
 * states, no French regions), so state lines have to come from 1:10m, which is
 * 6.4 MB of far more detail than a faint reference overlay needs. Simplifying it
 * and dropping sliver fragments gets it to a size worth downloading.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'borders');
const SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

// ~110 m, finer than the overlay is ever drawn at and far cheaper than the
// 6+ decimals Natural Earth ships.
const PRECISION = 3;

const LAYERS = [
  {
    name: 'countries',
    file: 'ne_50m_admin_0_boundary_lines_land',
    // The layer you actually read, so it keeps its detail.
    tolerance: 0.01,   // ~1 km
    minSpan: 0,
  },
  {
    name: 'states',
    file: 'ne_10m_admin_1_states_provinces_lines',
    // Drawn faint and thin, and 1:10m carries river-level wiggle no one can see
    // at these zooms.
    tolerance: 0.03,   // ~3 km
    minSpan: 0.1,      // drop fragments spanning under ~11 km
  },
];

const round = (n) => Math.round(n * 10 ** PRECISION) / 10 ** PRECISION;

/** Diagonal of a line's bounding box, in degrees. */
function span(line) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of line) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/** Douglas–Peucker, iterative so a 20k-point coastline cannot blow the stack. */
function simplify(points, tolerance) {
  if (points.length < 3 || !tolerance) return points;

  const limit = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start < 2) continue;

    const [ax, ay] = points[start];
    const [bx, by] = points[end];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;

    let farthest = -1;
    let worst = 0;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i];
      // Distance to the segment, not the infinite line: a closed ring's ends
      // coincide, and the infinite line through them is meaningless.
      let t = lengthSq ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const distSq = ex * ex + ey * ey;
      if (distSq > worst) {
        worst = distSq;
        farthest = i;
      }
    }

    if (worst > limit) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Rounds a line and drops points the rounding made identical to their neighbour. */
function thin(line) {
  const out = [];
  let last = '';
  for (const [lon, lat] of line) {
    const point = [round(lon), round(lat)];
    const key = `${point[0]},${point[1]}`;
    if (key === last) continue;
    out.push(point);
    last = key;
  }
  return out.length > 1 ? out : null;
}

async function build({ name, file, tolerance, minSpan }) {
  const url = `${SOURCE}/${file}.geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const source = await res.json();

  const lines = [];
  let dropped = 0;
  for (const feature of source.features ?? []) {
    const { type, coordinates } = feature.geometry ?? {};
    const parts = type === 'LineString' ? [coordinates] : coordinates ?? [];
    for (const part of parts) {
      if (minSpan && span(part) < minSpan) {
        dropped++;
        continue;
      }
      const line = thin(simplify(part, tolerance));
      if (line) lines.push(line);
    }
  }

  // One MultiLineString rather than a FeatureCollection: without properties
  // there is nothing to keep the features apart, and Leaflet draws it in one go.
  const geometry = { type: 'MultiLineString', coordinates: lines };
  const json = JSON.stringify(geometry);
  await writeFile(path.join(OUT_DIR, `${name}.json`), json);

  const points = lines.reduce((sum, line) => sum + line.length, 0);
  console.log(
    `${name.padEnd(10)} ${String(lines.length).padStart(5)} lines, ` +
    `${String(points).padStart(6)} points, ${(json.length / 1024).toFixed(0).padStart(4)} KB` +
    (dropped ? ` (${dropped} slivers dropped)` : ''),
  );
}

await mkdir(OUT_DIR, { recursive: true });
for (const layer of LAYERS) await build(layer);
console.log('\nSource: Natural Earth (naturalearthdata.com), public domain.');
