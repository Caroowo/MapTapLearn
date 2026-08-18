/** Distance + 1-100 scoring. */

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The yardstick every country is pulled toward, in km. Scoring purely against a
 * country's own size makes the same miss mean wildly different things — 200 km
 * off is a shrug in Russia and hopeless in the Netherlands — while scoring
 * purely on absolute distance makes small countries trivial and huge ones
 * hopeless. The scale below is the geometric mean of the two, which halves how
 * much the country matters without flattening it away.
 */
export const GENERAL_SCALE_KM = 1000;

/**
 * How much of a country's places the spread has to cover. Deliberately short of
 * everything: France reaches the Kerguelen Islands and Norway reaches Bouvet
 * Island, and one such point would otherwise set the yardstick for the whole
 * country — France's bounding box is 16,649 km across, which scored a 1,000 km
 * miss in Paris as 78 out of 100.
 */
const SPREAD_PERCENTILE = 0.85;

/** Smallest yardstick a country can have, so a tiny one is hard, not impossible. */
const MIN_SPREAD_KM = 60;

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Folds any angle back into -180..180. */
const wrap180 = (deg) => ((deg + 540) % 360) - 180;

/**
 * Median longitude, done on the circle.
 *
 * A plain median of 179 and -179 is 0 — the opposite side of the planet — which
 * would hand a country straddling the antimeridian a yardstick of half the
 * globe. The circular mean is only used to pick a side to unwrap around; the
 * median is what actually decides the centre, so a stray territory still cannot
 * drag it.
 */
function medianLongitude(lons) {
  const toRad = Math.PI / 180;
  let x = 0;
  let y = 0;
  for (const lon of lons) {
    x += Math.cos(lon * toRad);
    y += Math.sin(lon * toRad);
  }
  const reference = Math.atan2(y, x) / toRad;
  return wrap180(median(lons.map((lon) => reference + wrap180(lon - reference))));
}

/**
 * The scoring yardstick for a country, in km.
 *
 * Built from where the country's places actually are rather than its bounding
 * box: a median centre, the distance covering most of the places around it, and
 * doubled into a diameter. Medians and a percentile rather than extremes, so a
 * handful of overseas territories cannot stretch it.
 *
 * @param {Array<{lat:number, lon:number}>} locations every place in the country
 */
export function countryScaleKm(locations) {
  if (!locations?.length) return GENERAL_SCALE_KM;

  const centre = {
    lat: median(locations.map((l) => l.lat)),
    lon: medianLongitude(locations.map((l) => l.lon)),
  };
  const distances = locations.map((l) => distanceKm(centre, l)).sort((a, b) => a - b);
  const spread = Math.max(2 * quantile(distances, SPREAD_PERCENTILE), MIN_SPREAD_KM);

  return Math.sqrt(spread * GENERAL_SCALE_KM);
}

/**
 * How close counts as dead on. Landing within this of a place means you knew
 * where it was, and which pixel inside the city you happened to hit should not
 * be what decides the round.
 *
 * Flat rather than scaled to the country: the smallest country in the dataset is
 * ~153 km across, so this is at most a tenth of any yardstick.
 */
export const PERFECT_KM = 15;

/**
 * Score a guess on a 1-100 scale.
 * Within PERFECT_KM it is 100. Past that the curve is the same exponential
 * falloff against the country's own size, just measured from the edge of the
 * perfect radius, so the score eases out of 100 instead of stepping off it:
 * a quarter of the country away ≈ 37, half the country away ≈ 14.
 */
export function scoreGuess(distKm, scaleKm) {
  const beyond = Math.max(0, distKm - PERFECT_KM);
  const raw = 100 * Math.exp((-4 * beyond) / scaleKm);
  return Math.max(1, Math.min(100, Math.round(raw)));
}

export function verdict(score) {
  if (score >= 95) return 'Pinpoint.';
  if (score >= 80) return 'Very close.';
  if (score >= 60) return 'Good guess.';
  if (score >= 40) return 'In the region.';
  if (score >= 20) return 'Way off.';
  return 'Nowhere near.';
}

export function scoreBand(score) {
  if (score >= 70) return 'score-good';
  if (score >= 35) return 'score-mid';
  return 'score-bad';
}

export function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}
