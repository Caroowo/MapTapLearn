/** MapTap Learn — menu, game loop and result reporting. */

import {
  loadIndex,
  loadCountry,
  pool,
  poolSize,
  roundOrder,
  availableDifficulties,
} from './data.js';
import {
  distanceKm,
  countryScaleKm,
  scoreGuess,
  verdict,
  scoreBand,
  formatDistance,
} from './scoring.js';
import { MapView } from './mapview.js';
import { bestFor, saveResult, isPersistent } from './records.js';

const el = (id) => document.getElementById(id);

const ui = {
  menu: el('menu'),
  summary: el('summary'),
  hud: el('hud'),
  actionbar: el('actionbar'),
  result: el('result'),
  search: el('country-search'),
  countryList: el('country-list'),
  sorts: document.querySelectorAll('[data-sort]'),
  rounds: el('round-count'),
  roundsValue: el('round-count-value'),
  menuSummary: el('menu-summary'),
  menuBest: el('menu-best'),
  start: el('btn-start'),
  next: el('btn-next'),
  hint: el('action-hint'),
};

const state = {
  countries: [],
  selected: null,      // index entry {code,name,count,bbox,view}
  difficulty: 'easy',
  sort: { key: 'name', desc: false },
  rounds: 0,           // how many of the pool to play; the full pool by default
  poolKey: null,       // country+difficulty the round slider was last sized for
  game: null,
};

/** A short run is practice: it plays a random slice, so it sets no records. */
const isCustomRun = () => state.rounds < poolSize(state.difficulty, state.selected.count);

const view = new MapView('map');

/* ------------------------------------------------------------------ menu */

/** The difficulty the ★ badges were last built for, so they can be refreshed. */
let listedFor = null;

function renderCountryList(filter = ui.search.value) {
  const needle = filter.trim().toLowerCase();
  const matches = sortCountries(
    needle
      ? state.countries.filter(
          (c) => c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle,
        )
      : state.countries,
  );

  // Rebuilding the list would otherwise throw you back to the top mid-scroll.
  const scroll = ui.countryList.scrollTop;
  listedFor = state.difficulty;
  refreshSortButtons();
  ui.countryList.innerHTML = '';
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No country matches that';
    ui.countryList.append(li);
    return;
  }

  for (const country of matches.slice(0, 300)) {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.code = country.code;
    li.ariaSelected = String(state.selected?.code === country.code);
    const best = bestFor({ code: country.code, difficulty: state.difficulty });
    li.innerHTML =
      `<span>${country.name}</span>` +
      (best ? `<span class="best" title="Your best on ${state.difficulty}">★ ${best.avg}</span>` : '') +
      `<span class="count">${country.count}</span>`;
    li.addEventListener('click', () => selectCountry(country));
    ui.countryList.append(li);
  }
  ui.countryList.scrollTop = scroll;
}

/**
 * What the map opens on. `view` trims the outlying places so France does not
 * start framed on the Indian Ocean; older datasets without one fall back to the
 * full extent.
 */
const framing = (country) => country.view ?? country.bbox;

/**
 * How each sort orders the list, and which way round it starts. Bests are read
 * for the difficulty currently selected — "best" means nothing on its own, and
 * ranking your easy runs against your hard ones would compare different games.
 */
const SORTS = {
  name: { desc: false, of: () => 0 },
  places: { desc: true, of: (country) => country.count },
  best: { desc: true, of: (country) => bestFor({ code: country.code, difficulty: state.difficulty })?.avg ?? null },
};

function sortCountries(countries) {
  const { key, desc } = state.sort;
  const value = SORTS[key].of;
  const direction = desc ? -1 : 1;

  return [...countries].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    // A country you have never played has no rank, so it sorts to the bottom
    // either way round rather than pretending to be a zero.
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
    } else if (left !== right) {
      return (left < right ? -1 : 1) * direction;
    }
    return a.name.localeCompare(b.name) * (key === 'name' ? direction : 1);
  });
}

function refreshSortButtons() {
  for (const button of ui.sorts) {
    const key = button.dataset.sort;
    const active = key === state.sort.key;
    button.classList.toggle('is-active', active);
    button.ariaPressed = String(active);
    if (key === 'name') button.textContent = active && state.sort.desc ? 'Z–A' : 'A–Z';
    else button.textContent = `${key === 'places' ? 'Places' : 'Best'}${active ? (state.sort.desc ? ' ↓' : ' ↑') : ''}`;
  }
}

function currentSetup(country = state.selected) {
  return { code: country.code, difficulty: state.difficulty };
}

/**
 * Shows only the difficulties this country is big enough for, and moves the
 * selection off one that just disappeared — onto the easiest still standing,
 * since that is what the vanished button was.
 */
function refreshDifficulties(country) {
  const available = availableDifficulties(country.count);
  if (!available.includes(state.difficulty)) state.difficulty = available[0];

  for (const button of document.querySelectorAll('[data-difficulty]')) {
    const key = button.dataset.difficulty;
    const on = key === state.difficulty;
    button.hidden = !available.includes(key);
    button.classList.toggle('is-active', on);
    button.ariaChecked = String(on);
  }
}

function selectCountry(country) {
  state.selected = country;
  for (const li of ui.countryList.children) {
    li.ariaSelected = String(li.dataset.code === country.code);
  }
  view.frameCountry(framing(country));
  refreshMenu();
}

function refreshMenu() {
  const country = state.selected;

  if (!country) {
    ui.menuSummary.textContent = '';
    ui.menuBest.textContent = '';
    // Nothing picked yet, so there is no pool for the slider to mean anything in.
    ui.rounds.disabled = true;
    ui.roundsValue.textContent = '';
    ui.start.disabled = true;
    ui.start.textContent = 'Pick a country';
    return;
  }

  refreshDifficulties(country);
  // Badges and the "best" order belong to a difficulty, so they follow it —
  // including when picking a small country moved it on its own.
  if (listedFor !== state.difficulty) renderCountryList();
  const size = poolSize(state.difficulty, country.count);
  refreshRoundSlider(country, size);

  ui.menuSummary.textContent = state.rounds === country.count
    ? `${country.name} · all ${state.rounds} places, in a random order.`
    : `${country.name} · its ${state.rounds} biggest places, in a random order.`;

  const best = bestFor(currentSetup(country));
  const practice = isCustomRun();
  ui.menuBest.classList.toggle('is-practice', practice);
  if (practice) {
    ui.menuBest.textContent = 'Practice run — a shortened game sets no record';
  } else {
    ui.menuBest.textContent = best ? `★ Best at this setup: ${best.avg} avg` : '';
  }
  ui.start.disabled = false;
  ui.start.textContent = `Play ${country.name}`;
}

/**
 * Sizes the round slider to the pool. Picking a new country or difficulty snaps
 * it back to the full pool — the shortened run belongs to the setup you chose it
 * for, and silently carrying "12 rounds" into a 5-place pool would be nonsense.
 */
function refreshRoundSlider(country, size) {
  const poolKey = `${country.code}:${state.difficulty}`;
  if (poolKey !== state.poolKey) {
    state.poolKey = poolKey;
    state.rounds = size;
    ui.rounds.max = String(size);
    ui.rounds.value = String(size);
  }
  // A pool of one has nothing to slide.
  ui.rounds.disabled = size < 2;
  ui.rounds.ariaLabel = `Rounds: ${state.rounds} of ${size}`;
  ui.roundsValue.textContent = isCustomRun()
    ? `${state.rounds} of ${size}`
    : `all ${size}`;
}

function wireSorts() {
  for (const button of ui.sorts) {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      // Clicking the sort you are already on turns it around.
      state.sort = key === state.sort.key
        ? { key, desc: !state.sort.desc }
        : { key, desc: SORTS[key].desc };
      renderCountryList();
    });
  }
}

function wireDifficulties() {
  for (const button of document.querySelectorAll('[data-difficulty]')) {
    button.addEventListener('click', () => {
      state.difficulty = button.dataset.difficulty;
      refreshMenu();
    });
  }
}

/* ------------------------------------------------------------------ game */

async function startGame() {
  if (!state.selected) return;
  ui.start.disabled = true;
  ui.start.textContent = 'Loading…';

  let country;
  try {
    country = await loadCountry(state.selected.code);
  } catch (err) {
    ui.menuSummary.textContent = `Could not load ${state.selected.name}: ${err.message}`;
    refreshMenu();
    return;
  }

  // Cut first, then shuffle: a short run is the biggest places of the pool, in a
  // random order. Slicing a pool that is already sorted by population is what
  // makes "25 rounds" mean the 25 biggest rather than 25 arbitrary ones.
  const custom = isCustomRun();
  const targets = roundOrder(pool(country, state.difficulty).slice(0, state.rounds));
  state.game = {
    country,
    // Pinned at kick-off: the menu can be re-set before the summary is filed.
    difficulty: state.difficulty,
    custom,
    scaleKm: countryScaleKm(country.locations),
    targets,
    index: 0,
    guess: null,
    phase: 'guessing',
    results: [],
    total: 0,
  };

  ui.menu.hidden = true;
  ui.summary.hidden = true;
  ui.hud.hidden = false;
  refreshMenu();
  beginRound();
}

function beginRound() {
  const game = state.game;
  const target = game.targets[game.index];

  game.guess = null;
  game.phase = 'guessing';
  view.clearRound();
  view.frameCountry(framing(game.country));
  view.setPicking(true);

  el('hud-country').textContent = game.country.name;
  el('hud-progress').textContent = `Round ${game.index + 1} of ${game.targets.length}`;
  el('hud-place').textContent = target.name;
  el('hud-score').textContent = String(game.total);

  ui.result.hidden = true;
  ui.actionbar.hidden = false;
  ui.hint.textContent = 'Click the map to drop your pin';
}

/** One click is the whole guess: placing the pin scores it. */
function placeGuess(latlon) {
  const game = state.game;
  if (!game || game.phase !== 'guessing') return;

  game.guess = latlon;
  view.showGuess(latlon);

  const target = game.targets[game.index];
  const dist = distanceKm(game.guess, target);
  const points = scoreGuess(dist, game.scaleKm);

  game.phase = 'revealed';
  game.total += points;
  game.results.push({ name: target.name, distKm: dist, points });

  view.setPicking(false);
  view.reveal(game.guess, target, target.name);

  el('hud-score').textContent = String(game.total);
  ui.actionbar.hidden = true;
  ui.result.hidden = false;
  ui.result.className = `panel result ${scoreBand(points)}`;
  el('result-points').textContent = String(points);
  el('result-verdict').textContent = verdict(points);
  el('result-distance').textContent = `${formatDistance(dist)} from ${target.name}`;
  ui.next.textContent =
    game.index + 1 < game.targets.length ? 'Next round' : 'See results';
  ui.next.focus();
}

function nextRound() {
  const game = state.game;
  if (!game || game.phase !== 'revealed') return;
  game.index += 1;
  if (game.index >= game.targets.length) {
    finishGame();
    return;
  }
  beginRound();
}

function finishGame() {
  const game = state.game;
  const avg = Math.round(game.total / game.results.length);
  const best = game.results.reduce((a, b) => (b.points > a.points ? b : a));

  view.setPicking(false);
  ui.hud.hidden = true;
  ui.actionbar.hidden = true;
  ui.result.hidden = true;

  // A practice run played a random slice, so there is nothing to compare it to.
  const filed = game.custom
    ? null
    : saveResult(
        { code: game.country.code, difficulty: game.difficulty },
        { avg, total: game.total, places: game.results.length },
      );

  el('summary-title').textContent =
    `${game.country.name} · ${game.difficulty} · ${game.results.length} places`;
  el('summary-avg').textContent = String(avg);
  el('summary-line').textContent =
    `${game.total} points total · best round: ${best.name} (${best.points})`;

  const bestLine = el('summary-best');
  bestLine.classList.toggle('is-record', Boolean(filed?.isRecord));
  if (!filed) {
    const standing = bestFor({ code: game.country.code, difficulty: game.difficulty });
    bestLine.textContent = standing
      ? `Practice run — not scored. Your best at this setup: ${standing.avg} avg`
      : 'Practice run — not scored. Play the full pool to set a best.';
  } else if (filed.isRecord && filed.previous) {
    bestLine.textContent = `★ New best — you beat ${filed.previous.avg} avg`;
  } else if (filed.isRecord) {
    bestLine.textContent = '★ New best — first run at this setup';
  } else {
    bestLine.textContent = `Your best at this setup: ${filed.best.avg} avg`;
  }
  if (filed && !isPersistent()) bestLine.textContent += ' (this browser is not saving scores)';

  const list = el('summary-list');
  list.innerHTML = '';
  for (const r of game.results) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span>${r.name}</span>` +
      `<span class="s-dist">${formatDistance(r.distKm)}</span>` +
      `<span class="s-pts ${scoreBand(r.points)}">${r.points}</span>`;
    list.append(li);
  }
  ui.summary.hidden = false;
  if (filed?.isRecord) renderCountryList();
}

function quitToMenu() {
  state.game = null;
  view.clearRound();
  view.setPicking(false);
  ui.hud.hidden = true;
  ui.actionbar.hidden = true;
  ui.result.hidden = true;
  ui.summary.hidden = true;
  ui.menu.hidden = false;
  if (state.selected) view.frameCountry(framing(state.selected));
  else view.resetView();
  refreshMenu();
}

/* ------------------------------------------------------------------ boot */

function wireEvents() {
  view.onPick = placeGuess;
  ui.search.addEventListener('input', () => renderCountryList());
  ui.start.addEventListener('click', startGame);
  ui.next.addEventListener('click', nextRound);
  el('btn-quit').addEventListener('click', quitToMenu);
  el('btn-again').addEventListener('click', startGame);
  el('btn-menu').addEventListener('click', quitToMenu);

  wireDifficulties();
  wireSorts();
  ui.rounds.addEventListener('input', () => {
    state.rounds = Number(ui.rounds.value);
    refreshMenu();
  });

  // Enter/Space advances the round without hunting for the button. There is
  // nothing to confirm any more, so it only moves on from a revealed round.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target instanceof HTMLInputElement) return;
    if (state.game?.phase !== 'revealed') return;
    event.preventDefault();
    nextRound();
  });
}

async function boot() {
  wireEvents();
  try {
    const index = await loadIndex();
    state.countries = index.countries;
    el('data-source').textContent = index.sourceLabel ?? index.source ?? 'unknown';
    renderCountryList();
    refreshMenu();
  } catch (err) {
    ui.menuSummary.textContent = `Dataset failed to load: ${err.message}`;
  }
}

boot();
