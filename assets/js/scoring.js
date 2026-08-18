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
 * Diagonal of a country's bounding box, in km. Used as the scoring yardstick so
 * that being 40 km off in Luxembourg costs as much as being 40 km off in Russia
 * would relative to the country's own size.
 */
export function countryScaleKm(bbox) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  const diagonal = distanceKm(
    { lat: minLat, lon: minLon },
    { lat: maxLat, lon: maxLon },
  );
  // Floor keeps city-states (bbox ~ 0) from turning every guess into a 1.
  return Math.max(diagonal, 60);
}

/**
 * Score a guess on a 1-100 scale.
 * Exponential falloff against the country's own size: dead on = 100,
 * a quarter of the country away ≈ 37, half the country away ≈ 14.
 */
export function scoreGuess(distKm, scaleKm) {
  const raw = 100 * Math.exp((-4 * distKm) / scaleKm);
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
