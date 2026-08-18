/** MapTap Learn — menu, game loop and result reporting. */

import { loadIndex, loadCountry, pool, poolSize, selectRounds } from './data.js';
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
  menuSummary: el('menu-summary'),
  menuBest: el('menu-best'),
  start: el('btn-start'),
  confirm: el('btn-confirm'),
  next: el('btn-next'),
  hint: el('action-hint'),
};

const state = {
  countries: [],
  selected: null,      // index entry {code,name,count,bbox}
  difficulty: 'easy',
  rounds: 5,
  game: null,
};

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

/** The country's best average across every difficulty and round count. */
function topBest(code) {
  return bestsForCountry(code).reduce((a, b) => (!a || b.avg > a.avg ? b : a), null);
}

/**
 * A best belongs to a setup, and the rounds that count are the ones actually
 * played — asking for 20 in a 10-place pool plays 10.
 */
function currentSetup(country = state.selected) {
  return {
    code: country.code,
    difficulty: state.difficulty,
    rounds: Math.min(state.rounds, poolSize(state.difficulty, country.count)),
  };
}

function selectCountry(country) {
  state.selected = country;
  for (const li of ui.countryList.children) {
    li.ariaSelected = String(li.dataset.code === country.code);
  }
  view.frameCountry(country.bbox);
  refreshMenu();
}

function refreshMenu() {
  const country = state.selected;
  const total = country?.count ?? 0;

  el('pool-easy').textContent = country ? `${poolSize('easy', total)} places` : 'top 10';
  el('pool-medium').textContent = country ? `${poolSize('medium', total)} places` : 'top half';
  el('pool-hard').textContent = country ? `${total} places` : 'everything';

  if (!country) {
    ui.menuSummary.textContent = '';
    ui.menuBest.textContent = '';
    ui.start.disabled = true;
    ui.start.textContent = 'Pick a country';
    return;
  }

  const size = poolSize(state.difficulty, total);
  const rounds = Math.min(state.rounds, size);
  ui.menuSummary.textContent = `${country.name} · ${rounds} rounds spread across its ${size} biggest places.`;

  const best = bestFor(currentSetup(country));
  ui.menuBest.textContent = best ? `★ Best at this setup: ${best.avg} avg` : '';
  ui.start.disabled = false;
  ui.start.textContent = `Play ${country.name}`;
}

function wireSegmented(selector, key, cast = String) {
  for (const button of document.querySelectorAll(selector)) {
    button.addEventListener('click', () => {
      for (const sibling of button.parentElement.children) {
        sibling.classList.toggle('is-active', sibling === button);
        sibling.ariaChecked = String(sibling === button);
      }
      state[key] = cast(button.dataset[key]);
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

  const targets = selectRounds(pool(country, state.difficulty), state.rounds);
  state.game = {
    country,
    // Pinned at kick-off: the menu can be re-set before the summary is filed.
    difficulty: state.difficulty,
    scaleKm: countryScaleKm(country.bbox),
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
  view.frameCountry(game.country.bbox);
  view.setPicking(true);

  el('hud-country').textContent = game.country.name;
  el('hud-progress').textContent = `Round ${game.index + 1} of ${game.targets.length}`;
  el('hud-place').textContent = target.name;
  el('hud-score').textContent = String(game.total);

  ui.result.hidden = true;
  ui.actionbar.hidden = false;
  ui.hint.textContent = 'Click the map to place your pin';
  ui.confirm.disabled = true;
  ui.confirm.textContent = 'Confirm guess';
}

function placeGuess(latlon) {
  const game = state.game;
  if (!game || game.phase !== 'guessing') return;
  game.guess = latlon;
  view.showGuess(latlon);
  ui.confirm.disabled = false;
  ui.hint.textContent = 'Drag or click again to adjust';
}

function confirmGuess() {
  const game = state.game;
  if (!game || game.phase !== 'guessing' || !game.guess) return;

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

  const { best: record, previous, isRecord } = saveResult(
    { code: game.country.code, difficulty: game.difficulty, rounds: game.results.length },
    { avg, total: game.total },
  );

  el('summary-title').textContent =
    `${game.country.name} · ${game.difficulty} · ${game.results.length} rounds`;
  el('summary-avg').textContent = String(avg);
  el('summary-line').textContent =
    `${game.total} points total · best round: ${best.name} (${best.points})`;

  const bestLine = el('summary-best');
  bestLine.classList.toggle('is-record', isRecord);
  if (isRecord && previous) bestLine.textContent = `★ New best — you beat ${previous.avg} avg`;
  else if (isRecord) bestLine.textContent = '★ New best — first run at this setup';
  else bestLine.textContent = `Your best at this setup: ${record.avg} avg`;
  if (!isPersistent()) bestLine.textContent += ' (this browser is not saving scores)';

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
  if (isRecord) renderCountryList(ui.search.value);
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
  if (state.selected) view.frameCountry(state.selected.bbox);
  else view.resetView();
  refreshMenu();
}

/* ------------------------------------------------------------------ boot */

function wireEvents() {
  view.onPick = placeGuess;
  ui.search.addEventListener('input', () => renderCountryList(ui.search.value));
  ui.start.addEventListener('click', startGame);
  ui.confirm.addEventListener('click', confirmGuess);
  ui.next.addEventListener('click', nextRound);
  el('btn-quit').addEventListener('click', quitToMenu);
  el('btn-again').addEventListener('click', startGame);
  el('btn-menu').addEventListener('click', quitToMenu);

  wireSegmented('[data-difficulty]', 'difficulty');
  wireSegmented('[data-rounds]', 'rounds', Number);

  // Enter/Space advances the round without hunting for the button.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target instanceof HTMLInputElement) return;
    if (!state.game) return;
    event.preventDefault();
    if (state.game.phase === 'guessing') confirmGuess();
    else nextRound();
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
