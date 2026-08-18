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

/** Picks `count` distinct locations from the pool, biased toward nothing — pure random. */
export function drawRounds(locations, count) {
  const bag = [...locations];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag.slice(0, Math.min(count, bag.length));
}
