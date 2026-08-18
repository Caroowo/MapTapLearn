/**
 * Personal bests, kept in localStorage.
 *
 * A best is stored per setup — country, difficulty and the number of rounds
 * actually played — because those are what make a score comparable. Averaging
 * 80 over 5 rounds and over 20 rounds are different achievements, so they do
 * not overwrite each other.
 *
 * Storage is best-effort: reading or writing localStorage throws outright in
 * some browsers (private mode, cookies disabled, a `file://` page under a strict
 * policy). Every access goes through here, and when it fails the game keeps
 * playing with bests held in memory for the session.
 */

const KEY = 'maptap-learn.records.v1';
const VERSION = 1;

/** Parsed records, loaded once. Also the whole store when localStorage is out. */
let cache = null;
let persistent = true;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access itself can throw
  }
}

function load() {
  if (cache) return cache;

  cache = {};
  const store = storage();
  if (!store) {
    persistent = false;
    return cache;
  }

  try {
    const parsed = JSON.parse(store.getItem(KEY) ?? '{}');
    // Anything older or hand-mangled starts over rather than half-loading.
    if (parsed?.v === VERSION && parsed.bests && typeof parsed.bests === 'object') {
      cache = parsed.bests;
    }
  } catch {
    persistent = false;
  }
  return cache;
}

function persist() {
  const store = storage();
  if (!store) {
    persistent = false;
    return;
  }
  try {
    store.setItem(KEY, JSON.stringify({ v: VERSION, bests: cache }));
    persistent = true;
  } catch {
    // Out of quota, or writes refused. The in-memory copy still serves this
    // session; nothing here is worth interrupting a game over.
    persistent = false;
  }
}

/** True while bests are actually surviving a reload. */
export function isPersistent() {
  load();
  return persistent;
}

/** @param {{code:string, difficulty:string, rounds:number}} setup */
function keyFor({ code, difficulty, rounds }) {
  return `${code}:${difficulty}:${rounds}`;
}

/**
 * @param {{code:string, difficulty:string, rounds:number}} setup
 * @returns {{avg:number, total:number, at:string}|null}
 */
export function bestFor(setup) {
  return load()[keyFor(setup)] ?? null;
}

/** Every stored best for a country, whatever the difficulty or round count. */
export function bestsForCountry(code) {
  const prefix = `${code}:`;
  return Object.entries(load())
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, record]) => {
      const [, difficulty, rounds] = key.split(':');
      return { difficulty, rounds: Number(rounds), ...record };
    });
}

/**
 * Files a finished game.
 * @param {{code:string, difficulty:string, rounds:number}} setup
 * @param {{avg:number, total:number}} result
 * @returns {{best:object, previous:object|null, isRecord:boolean}} `best` is the
 *   record that now stands — the new one only if it beat what was there.
 */
export function saveResult(setup, { avg, total }) {
  const bests = load();
  const key = keyFor(setup);
  const previous = bests[key] ?? null;
  // A tie is not a new best; matching your own record leaves it standing.
  const isRecord = !previous || avg > previous.avg;

  if (isRecord) {
    bests[key] = { avg, total, at: new Date().toISOString() };
    persist();
  }
  return { best: bests[key], previous, isRecord };
}

/** Wipes every stored best. */
export function clearRecords() {
  cache = {};
  const store = storage();
  try {
    store?.removeItem(KEY);
  } catch {
    persistent = false;
  }
}
