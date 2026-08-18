/** Loading + slicing of the location dataset. */

const INDEX_URL = 'data/index.json';
const countryCache = new Map();

/** @returns {Promise<{sourceLabel:string, countries:Array<{code:string,name:string,count:number,bbox:number[],view:number[]}>}>} */
export async function loadIndex() {
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`Could not load ${INDEX_URL} (${res.status})`);
  return res.json();
}

/** @returns {Promise<{code:string,name:string,bbox:number[],view:number[],locations:Array<{name:string,lat:number,lon:number,pop:number}>}>} */
export async function loadCountry(code) {
  if (!countryCache.has(code)) {
    countryCache.set(
      code,
      fetch(`data/countries/${code}.json`).then((res) => {
        if (!res.ok) throw new Error(`Could not load country ${code} (${res.status})`);
        return res.json();
      }).catch((err) => {
        countryCache.delete(code);
        throw err;
      }),
    );
  }
  return countryCache.get(code);
}

/**
 * Difficulty is the whole setup: it decides how many of a country's places a
 * game asks about, and the game asks about all of them. Locations are stored
 * sorted by population descending, so a pool is always "the N best-known
 * places" rather than a sample.
 */
export const DIFFICULTIES = {
  easy: { label: 'Easy', size: (total) => Math.min(5, total) },
  medium: { label: 'Medium', size: (total) => Math.ceil(total / 2) },
  hard: { label: 'Hard', size: (total) => total },
};

export function poolSize(difficulty, total) {
  return DIFFICULTIES[difficulty].size(total);
}

/**
 * The difficulties worth offering for a country, easiest first.
 *
 * Small countries collapse the ladder: with 10 places the top half is also five
 * places, so medium and easy are the same game, and with 6 the top half is
 * *smaller* than easy. Walking from hard down and keeping a tier only when it is
 * strictly smaller than the one above drops the redundant easier tier rather
 * than offering two buttons that play alike.
 */
export function availableDifficulties(total) {
  const kept = [];
  let smallest = Infinity;
  for (const difficulty of ['hard', 'medium', 'easy']) {
    const size = poolSize(difficulty, total);
    if (size >= smallest || size < 1) continue;
    kept.unshift(difficulty);
    smallest = size;
  }
  return kept;
}

/** The playable slice of a country for a difficulty. */
export function pool(country, difficulty) {
  return country.locations.slice(0, poolSize(difficulty, country.locations.length));
}

function shuffle(items) {
  const bag = [...items];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

/**
 * The rounds of a game: every place in the pool, in a random order.
 *
 * Which places you get is fixed by the difficulty, so two runs are comparable
 * and a personal best is a target you can chase; only the order changes, so a
 * country doesn't turn into a memorized sequence.
 */
export function roundOrder(locations) {
  return shuffle(locations);
}
