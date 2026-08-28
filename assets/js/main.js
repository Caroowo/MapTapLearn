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
  formatPopulation,
} from './scoring.js';
import { MapView } from './mapview.js';
import { bestFor, saveResult, isPersistent } from './records.js';

const el = (id) => document.getElementById(id);

const ui = {
  menu: el('menu'),
  summary: el('summary'),
  preview: el('preview'),
  previewList: el('preview-list'),
  previewBtn: el('btn-preview'),
  previewPeek: el('btn-preview-peek'),
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
  review: el('btn-review'),
  legend: el('summary-legend'),
  peek: el('btn-peek'),
  unpeek: el('btn-unpeek'),
};

const state = {
  countries: [],
  selected: null,      // index entry {code,name,count,bbox,view}
  difficulty: 'easy',
  sort: { key: 'name', desc: false },
  rounds: 0,           // how many of the pool to play; the full pool by default
  poolKey: null,       // country+difficulty the round slider was last sized for
  game: null,
  reviewing: false,    // the finished run is drawn on the map
  focused: null,       // the round singled out of that run, if any
  preview: null,       // the pool being studied on the map, if any
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
    ui.previewBtn.disabled = true;
    ui.previewBtn.textContent = 'Preview its locations';
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
  ui.previewBtn.disabled = false;
  // The preview shows the pool, not the run: a shortened game still asks about
  // the biggest places, which is what the slider cuts down to.
  ui.previewBtn.textContent = `Preview ${state.rounds} location${state.rounds === 1 ? '' : 's'}`;
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
  closePreview();
  setReviewing(false);
  view.clearReview();
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
  // The coordinates are kept so the finish screen can lay the whole run back
  // out on the map, which is where a miss actually means something.
  game.results.push({
    name: target.name,
    distKm: dist,
    points,
    guess: { ...game.guess },
    actual: { lat: target.lat, lon: target.lon },
  });

  view.setPicking(false);
  view.reveal(game.guess, target, target.name);

  el('hud-score').textContent = String(game.total);
  ui.actionbar.hidden = true;
  ui.result.hidden = false;
  ui.result.className = `panel result ${scoreBand(points)}`;
  el('result-points').textContent = String(points);
  el('result-verdict').textContent = verdict(points);
  el('result-distance').textContent = `${formatDistance(dist)} from ${target.name}`;

  // Population is a fact about the place worth learning alongside where it is.
  // Places the dataset has no figure for simply drop the line.
  const people = formatPopulation(target.pop);
  const popLine = el('result-pop');
  popLine.hidden = people === null;
  popLine.textContent = people === null ? '' : `Population ${people}`;
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
  // The last round's own pins go: the run about to be drawn includes them, and
  // two markers on one spot in different colours reads as a bug.
  view.clearRound();
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
  for (const [i, r] of game.results.entries()) {
    const li = document.createElement('li');
    // A row is the round's handle on the map, so it is a button, not a line of
    // text: clicking it opens the run and zooms to that one miss.
    li.innerHTML =
      `<button type="button" class="s-row ${scoreBand(r.points)}" data-round="${i}">` +
      `<span class="s-name">${r.name}</span>` +
      `<span class="s-dist">${formatDistance(r.distKm)}</span>` +
      `<span class="s-pts ${scoreBand(r.points)}">${r.points}</span>` +
      `</button>`;
    li.querySelector('.s-row').addEventListener('click', () => focusRound(i));
    list.append(li);
  }
  // The run is built now but kept off the map: the summary opens on the numbers,
  // and the pins are one button away for when you want to see where they landed.
  view.showReview(
    game.results.map((r) => ({ name: r.name, band: scoreBand(r.points), guess: r.guess, actual: r.actual })),
  );
  setReviewing(false);
  ui.summary.hidden = false;
  if (filed?.isRecord) renderCountryList();
}

/* -------------------------------------------------------------- review */

/**
 * Puts the finished run on the map, or takes it back off. Reviewing docks the
 * summary to one side and hands the map back: the point is to look at where the
 * pins landed, which a panel across the middle of the screen makes impossible.
 */
function setReviewing(on) {
  state.reviewing = on;
  if (!on) unpeek();
  state.focused = null;
  view.setReviewVisible(on);
  if (on) view.unfocusReview();

  ui.summary.classList.toggle('is-review', on);
  ui.legend.hidden = !on;
  ui.peek.hidden = !on;
  ui.review.ariaPressed = String(on);
  ui.review.classList.toggle('is-on', on);
  ui.review.querySelector('.chip-text').textContent =
    on ? 'Hide the pins' : 'Show every round on the map';
  for (const row of ui.summary.querySelectorAll('.s-row')) row.classList.remove('is-focus');
  if (on) refitReview();
  else if (state.game) view.frameCountry(framing(state.game.country));
}

/**
 * Frames the run in the part of the map the panel is not sitting on — beside it
 * on a wide screen, above it on a phone, and the whole viewport once the panel
 * has been tucked away.
 */
function refitReview() {
  const panel = ui.summary.querySelector('.panel');
  const tucked = !ui.unpeek.hidden;
  // Tucked away, the panel is gone but the pill that brings it back is not.
  const box = tucked ? { width: 0, height: 74 } : panel.getBoundingClientRect();
  view.setReviewPadding(
    !tucked && window.innerWidth > 560
      ? { topLeft: [box.width + 46, 70], bottomRight: [60, 70] }
      : { topLeft: [40, 70], bottomRight: [40, box.height + 46] },
  );
  if (state.focused === null) view.fitReview();
  else view.focusReview(state.focused);
}

/** Singles out one round; clicking the same row again zooms back out to all. */
function focusRound(index) {
  if (!state.reviewing) setReviewing(true);
  const same = state.focused === index;
  state.focused = same ? null : index;

  for (const row of ui.summary.querySelectorAll('.s-row')) {
    row.classList.toggle('is-focus', Number(row.dataset.round) === state.focused);
  }
  if (same) view.unfocusReview();
  refitReview();
}

/** Whichever panel is currently docked beside the map, if either is. */
function openPanel() {
  if (!ui.preview.hidden) return ui.preview;
  if (!ui.summary.hidden && state.reviewing) return ui.summary;
  return null;
}

/** Re-frames whatever the open panel is showing, around the panel. */
function refit() {
  if (!ui.preview.hidden) refitPreview();
  else if (state.reviewing) refitReview();
}

/** Tucks the panel away so nothing at all is over the map. */
function peek() {
  const panel = openPanel();
  if (!panel) return;
  panel.classList.add('is-peeking');
  // The pill is the way back, so it says what it brings back.
  ui.unpeek.textContent = panel === ui.preview ? 'Locations' : 'Results';
  ui.unpeek.hidden = false;
  ui.unpeek.focus();
  refit();
}

function unpeek() {
  const wasTucked = !ui.unpeek.hidden;
  ui.summary.classList.remove('is-peeking');
  ui.preview.classList.remove('is-peeking');
  ui.unpeek.hidden = true;
  if (wasTucked && openPanel()) refit();
}

/* ------------------------------------------------------------- preview */

/**
 * The study screen: the country's pool on the map with nothing scored, so you
 * can learn where the places are before being asked. It borrows the finish
 * screen's shape — a docked list, a row per place, click one to fly to it —
 * minus everything about a run that hasn't happened yet.
 */
async function openPreview() {
  if (!state.selected) return;
  const label = ui.previewBtn.textContent;
  ui.previewBtn.disabled = true;
  ui.previewBtn.textContent = 'Loading…';

  let country;
  try {
    country = await loadCountry(state.selected.code);
  } catch (err) {
    ui.menuSummary.textContent = `Could not load ${state.selected.name}: ${err.message}`;
    ui.previewBtn.textContent = label;
    refreshMenu();
    return;
  }
  // Picking a country while the fetch was in flight would otherwise open the
  // wrong one's places.
  if (country.code !== state.selected.code) {
    refreshMenu();
    return;
  }

  // The same slice the round would ask about: the biggest places first, in
  // population order rather than shuffled — this screen is for reading, and a
  // list you can find a place in beats a list that mimics the game's order.
  const places = pool(country, state.difficulty).slice(0, state.rounds);
  state.preview = { country, difficulty: state.difficulty, places, focused: null };

  el('preview-title').textContent = `${country.name} · ${places.length} place${places.length === 1 ? '' : 's'}`;
  el('preview-line').textContent =
    `${state.difficulty} · biggest first. Nothing here is scored.`;

  const list = ui.previewList;
  list.innerHTML = '';
  for (const [i, place] of places.entries()) {
    const people = formatPopulation(place.pop);
    const li = document.createElement('li');
    li.innerHTML =
      `<button type="button" class="s-row" data-place="${i}">` +
      `<span class="s-name"></span>` +
      `<span class="s-dist">${people === null ? '' : people}</span>` +
      `</button>`;
    // Place names come from the dataset, so they go in as text, never markup.
    li.querySelector('.s-name').textContent = place.name;
    li.querySelector('.s-row').addEventListener('click', () => focusPlace(i));
    list.append(li);
  }

  view.clearRound();
  view.clearReview();
  view.showPreview(places);
  ui.menu.hidden = true;
  ui.preview.hidden = false;
  refreshMenu();
  refitPreview();
}

/** Frames the pool in the part of the map the panel is not sitting on. */
function refitPreview() {
  const panel = ui.preview.querySelector('.panel');
  const tucked = !ui.unpeek.hidden;
  const box = tucked ? { width: 0, height: 74 } : panel.getBoundingClientRect();
  view.setReviewPadding(
    !tucked && window.innerWidth > 560
      ? { topLeft: [box.width + 46, 70], bottomRight: [60, 70] }
      : { topLeft: [40, 70], bottomRight: [40, box.height + 46] },
  );
  if (state.preview?.focused === null) view.fitPreview();
  else view.focusPreview(state.preview.focused);
}

/** Singles out one place; clicking the same row again zooms back out to all. */
function focusPlace(index) {
  if (!state.preview) return;
  const same = state.preview.focused === index;
  state.preview.focused = same ? null : index;

  for (const row of ui.previewList.querySelectorAll('.s-row')) {
    row.classList.toggle('is-focus', Number(row.dataset.place) === state.preview.focused);
  }
  if (same) view.unfocusPreview();
  refitPreview();
}

function closePreview() {
  state.preview = null;
  view.clearPreview();
  unpeek();
  ui.preview.hidden = true;
}

function previewToMenu() {
  closePreview();
  ui.menu.hidden = false;
  if (state.selected) view.frameCountry(framing(state.selected));
  refreshMenu();
}

function quitToMenu() {
  state.game = null;
  closePreview();
  setReviewing(false);
  view.clearReview();
  view.clearRound();
  view.setPicking(false);
  // The last round's own pins go: the run about to be drawn includes them, and
  // two markers on one spot in different colours reads as a bug.
  view.clearRound();
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
  ui.review.addEventListener('click', () => setReviewing(!state.reviewing));
  ui.peek.addEventListener('click', peek);
  ui.previewPeek.addEventListener('click', peek);
  ui.unpeek.addEventListener('click', unpeek);
  ui.previewBtn.addEventListener('click', openPreview);
  el('btn-preview-play').addEventListener('click', startGame);
  el('btn-preview-back').addEventListener('click', previewToMenu);

  wireDifficulties();
  wireSorts();
  ui.rounds.addEventListener('input', () => {
    state.rounds = Number(ui.rounds.value);
    refreshMenu();
  });

  // Enter/Space advances the round without hunting for the button. There is
  // nothing to confirm any more, so it only moves on from a revealed round.
  document.addEventListener('keydown', (event) => {
    // On the study screen Escape backs out one step at a time too: the
    // tucked-away panel, then the place singled out, then the screen itself.
    if (event.key === 'Escape' && !ui.preview.hidden) {
      if (!ui.unpeek.hidden) unpeek();
      else if (state.preview?.focused !== null) focusPlace(state.preview.focused);
      else previewToMenu();
      return;
    }
    // On the finish screen Escape backs out one step at a time: the tucked-away
    // panel first, then the focused round, then the pins.
    if (event.key === 'Escape' && !ui.summary.hidden) {
      if (!ui.unpeek.hidden) unpeek();
      else if (state.focused !== null) focusRound(state.focused);
      else if (state.reviewing) setReviewing(false);
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target instanceof HTMLInputElement) return;
    // The finish and study screens have their own buttons to press.
    if (!ui.summary.hidden || !ui.preview.hidden) return;
    if (state.game?.phase !== 'revealed') return;
    event.preventDefault();
    nextRound();
  });
}

/** A rotated phone changes which side of the map the panel is on. */
function wireResize() {
  let timer = null;
  window.addEventListener('resize', () => {
    if (!openPanel()) return;
    clearTimeout(timer);
    timer = setTimeout(refit, 150);
  });
}

async function boot() {
  wireEvents();
  wireResize();
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
