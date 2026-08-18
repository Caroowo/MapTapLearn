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
import { bestFor, bestsForCountry, saveResult, isPersistent } from './records.js';

const el = (id) => document.getElementById(id);

const ui = {
  menu: el('menu'),
  summary: el('summary'),
  hud: el('hud'),
  actionbar: el('actionbar'),
  result: el('result'),
  search: el('country-search'),
  countryList: el('country-list'),
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
  rounds: 0,           // how many of the pool to play; the full pool by default
  poolKey: null,       // country+difficulty the round slider was last sized for
  game: null,
};

/** A short run is practice: it plays a random slice, so it sets no records. */
const isCustomRun = () => state.rounds < poolSize(state.difficulty, state.selected.count);

const view = new MapView('map');

/* ------------------------------------------------------------------ menu */

function renderCountryList(filter = '') {
  const needle = filter.trim().toLowerCase();
  const matches = needle
    ? state.countries.filter(
        (c) => c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle,
      )
    : state.countries;

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
    const best = topBest(country.code);
    li.innerHTML =
      `<span>${country.name}</span>` +
      (best ? `<span class="best" title="Your best average here">★ ${best.avg}</span>` : '') +
      `<span class="count">${country.count}</span>`;
    li.addEventListener('click', () => selectCountry(country));
    ui.countryList.append(li);
  }
}

/**
 * What the map opens on. `view` trims the outlying places so France does not
 * start framed on the Indian Ocean; older datasets without one fall back to the
 * full extent.
 */
const framing = (country) => country.view ?? country.bbox;

/** The country's best average across every difficulty and round count. */
function topBest(code) {
  return bestsForCountry(code).reduce((a, b) => (!a || b.avg > a.avg ? b : a), null);
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
    ui.start.disabled = true;
    ui.start.textContent = 'Pick a country';
    return;
  }

  refreshDifficulties(country);
  const size = poolSize(state.difficulty, country.count);
  refreshRoundSlider(country, size);

  const pick = size === country.count
    ? `all ${size} places`
    : `its ${size} biggest places`;
  ui.menuSummary.textContent = isCustomRun()
    ? `${country.name} · ${state.rounds} places drawn from ${pick}.`
    : `${country.name} · ${pick}, in a random order.`;

  const best = bestFor(currentSetup(country));
  const practice = isCustomRun();
  ui.menuBest.classList.toggle('is-practice', practice);
  if (practice) {
    ui.menuBest.textContent = 'Practice run — a short game sets no record';
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
  ui.roundsValue.textContent = isCustomRun()
    ? `${state.rounds} of ${size}`
    : `all ${size}`;
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

  // Shuffle first, then cut: a short run is a random slice of the pool, not its
  // biggest few — those are what the easier difficulty already plays.
  const custom = isCustomRun();
  const targets = roundOrder(pool(country, state.difficulty)).slice(0, state.rounds);
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
  if (filed?.isRecord) renderCountryList(ui.search.value);
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
  ui.search.addEventListener('input', () => renderCountryList(ui.search.value));
  ui.start.addEventListener('click', startGame);
  ui.next.addEventListener('click', nextRound);
  el('btn-quit').addEventListener('click', quitToMenu);
  el('btn-again').addEventListener('click', startGame);
  el('btn-menu').addEventListener('click', quitToMenu);

  wireDifficulties();
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
