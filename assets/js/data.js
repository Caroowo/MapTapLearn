/** Loading + slicing of the location dataset. */

const INDEX_URL = 'data/index.json';
const countryCache = new Map();

/** @returns {Promise<{sourceLabel:string, countries:Array<{code:string,name:string,count:number,bbox:number[]}>}>} */
export async function loadIndex() {
  const res = await fetch(INDEX_URL);
  if (!res.ok) throw new Error(`Could not load ${INDEX_URL} (${res.status})`);
  return res.json();
}

/** @returns {Promise<{code:string,name:string,bbox:number[],locations:Array<{name:string,lat:number,lon:number,pop:number}>}>} */
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

export const DIFFICULTIES = {
  easy: { label: 'Easy', describe: (n) => `top ${Math.min(10, n)} by population` },
  medium: { label: 'Medium', describe: (n) => `top ${poolSize('medium', n)} by population` },
  hard: { label: 'Hard', describe: (n) => `all ${n}` },
};

/**
 * How many of a country's locations a difficulty unlocks.
 * Locations are stored sorted by population descending, so a pool is always
 * "the N best-known places" rather than a random sample.
 */
export function poolSize(difficulty, total) {
  if (difficulty === 'easy') return Math.min(10, total);
  if (difficulty === 'medium') return Math.max(Math.min(10, total), Math.ceil(total / 2));
  return total;
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
 * The places a game plays, given a pool and a round count.
 *
 * The same setup always yields the same places — a personal best only means
 * something if the run behind it can be repeated. Only their order is shuffled,
 * so a country doesn't turn into a memorized sequence.
 *
 * They are spread evenly across the pool by population rank rather than sliced
 * off the top, because the pools are nested: the ten biggest places are in every
 * difficulty, so "the top five" would hand easy, medium and hard the identical
 * five cities. Spreading keeps the biggest place in every game and lets the
 * harder pools reach as deep as they actually go.
 */
export function selectRounds(locations, count) {
  const n = Math.min(count, locations.length);
  if (n <= 0) return [];
  if (n >= locations.length) return shuffle(locations);

  // n points from rank 0 to the pool's last rank, endpoints included.
  const step = n === 1 ? 0 : (locations.length - 1) / (n - 1);
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(locations[Math.round(i * step)]);
  return shuffle(picked);
}
