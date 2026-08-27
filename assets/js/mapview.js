/* global L */
/** Thin wrapper around the Leaflet map: basemap, pins, reveal animation. */

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const BORDER_LAYERS = [
  // Both layers have to be legible over satellite imagery, which is busy and
  // mostly mid-tone. The hierarchy between them comes from weight and the dash
  // rather than from fading the states out — a line you have to squint at is not
  // much use as an aid.
  { name: 'countries', url: 'data/borders/countries.json', style: { color: '#ffffff', weight: 1.8, opacity: 0.95 } },
  { name: 'states', url: 'data/borders/states.json', style: { color: '#ffffff', weight: 1.1, opacity: 0.7, dashArray: '5 4' } },
];

/** Score bands, in the same colours the summary list scores them with. */
const BAND_COLOR = {
  'score-good': '#47d18b',
  'score-mid': '#ffc857',
  'score-bad': '#ff6b6b',
};

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dot(kind, label) {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}"></div>${label ? `<span class="pin-label">${escapeHtml(label)}</span>` : ''}`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/**
 * A review pin. Both ends of a round carry the round's score colour, so a bad
 * one reads as bad from across the map; the shape is what tells them apart —
 * a ring is where you put your pin, a filled dot is where the place actually is.
 */
function reviewDot(kind, band, label) {
  const colour = BAND_COLOR[band];
  return L.divIcon({
    className: 'review-icon',
    html:
      `<div class="pin pin-review pin-review-${kind}" style="--band:${colour}"></div>` +
      (label ? `<span class="pin-label pin-label-review" style="--band:${colour}">${escapeHtml(label)}</span>` : ''),
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

export class MapView {
  constructor(elementId) {
    this.map = L.map(elementId, {
      worldCopyJump: true,
      zoomControl: false,
      minZoom: 2,
      maxZoom: 17,
      attributionControl: true,
      zoomSnap: 0.25,
    }).setView([25, 10], 2.5);

    L.tileLayer(ESRI_IMAGERY, {
      attribution: ESRI_ATTRIBUTION,
      maxZoom: 17,
      // Esri serves imagery to z19, but the game stays deliberately label-free
      // and coarse so the answer is never simply readable off the map.
      noWrap: false,
    }).addTo(this.map);

    this.borders = null;      // the layer group, once fetched
    this.bordersOn = false;
    this.bordersButton = this.addBordersControl();

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    this.guessMarker = null;
    this.actualMarker = null;
    this.link = null;
    this.onPick = null;

    this.review = null;       // layer group of every round, once a game is over
    this.reviewPairs = [];    // per round: {line, guess, actual}
    // How much of the viewport the summary panel is sitting on, so a fit puts
    // the run in the part of the map you can actually see.
    this.reviewPad = { topLeft: [60, 80], bottomRight: [60, 120] };

    this.pickingEnabled = false;
    this.map.on('click', (event) => {
      if (!this.pickingEnabled || !this.onPick) return;
      const { lat, lng } = event.latlng;
      this.onPick({ lat, lon: ((lng + 540) % 360) - 180 });
    });
  }

  /** The Borders toggle, in the same corner stack as the zoom buttons. */
  addBordersControl() {
    const control = L.control({ position: 'bottomright' });
    let button;

    control.onAdd = () => {
      const bar = L.DomUtil.create('div', 'leaflet-bar');
      button = L.DomUtil.create('a', 'borders-btn', bar);
      button.href = '#';
      button.title = 'Show country and state borders';
      button.textContent = 'Borders';
      button.setAttribute('role', 'button');
      button.setAttribute('aria-pressed', 'false');
      // Without this a click on the button also drops a pin underneath it.
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(button, 'click', (event) => {
        L.DomEvent.preventDefault(event);
        this.toggleBorders();
      });
      return bar;
    };

    control.addTo(this.map);
    return button;
  }

  async toggleBorders() {
    if (!this.borders) {
      // Half a megabyte of line work, so it is fetched the first time it is
      // asked for rather than on every page load.
      this.bordersButton.classList.add('is-loading');
      try {
        this.borders = await this.loadBorders();
      } catch {
        this.bordersButton.classList.remove('is-loading');
        this.bordersButton.title = 'Borders could not be loaded';
        return;
      }
      this.bordersButton.classList.remove('is-loading');
    }

    this.bordersOn = !this.bordersOn;
    if (this.bordersOn) this.borders.addTo(this.map);
    else this.map.removeLayer(this.borders);
    this.bordersButton.classList.toggle('is-on', this.bordersOn);
    this.bordersButton.setAttribute('aria-pressed', String(this.bordersOn));
  }

  async loadBorders() {
    const group = L.layerGroup();
    // Canvas, not SVG: the state layer is ~19k polylines, which as 19k DOM nodes
    // would stall every pan. On canvas it is one draw pass.
    const renderer = L.canvas({ padding: 0.3 });

    const layers = await Promise.all(
      BORDER_LAYERS.map(async ({ url, style }) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} (${res.status})`);
        return L.geoJSON(await res.json(), {
          // Non-interactive, or a click landing on a border line would be
          // swallowed instead of dropping a pin.
          style: { ...style, interactive: false },
          interactive: false,
          renderer,
        });
      }),
    );
    // Countries added last so they draw over the state lines.
    for (const layer of layers.reverse()) group.addLayer(layer);
    return group;
  }

  /** Enables/disables pin placement for the current round. */
  setPicking(enabled) {
    this.pickingEnabled = enabled;
    document.getElementById('map').classList.toggle('is-idle', !enabled);
  }

  showGuess({ lat, lon }) {
    if (this.guessMarker) {
      this.guessMarker.setLatLng([lat, lon]);
    } else {
      this.guessMarker = L.marker([lat, lon], {
        icon: dot('guess', 'You'),
        keyboard: false,
        interactive: false,
      }).addTo(this.map);
    }
  }

  /** Reveals the true location, draws the link line and frames both points. */
  reveal(guess, actual, label) {
    this.actualMarker = L.marker([actual.lat, actual.lon], {
      icon: dot('actual', label),
      keyboard: false,
      interactive: false,
    }).addTo(this.map);

    this.link = L.polyline(
      [
        [guess.lat, guess.lon],
        [actual.lat, actual.lon],
      ],
      { color: '#ffffff', weight: 2, opacity: 0.75, dashArray: '6 7' },
    ).addTo(this.map);

    this.map.fitBounds(this.link.getBounds(), {
      paddingTopLeft: [60, 110],
      paddingBottomRight: [60, 190],
      maxZoom: 11,
      animate: true,
    });
  }

  /**
   * Draws every round of a finished game at once: your pin, the real place and
   * the line between them, coloured by what that round scored.
   *
   * @param {Array<{name:string, band:string, guess:{lat,lon}, actual:{lat,lon}}>} rounds
   */
  showReview(rounds) {
    this.clearReview();
    this.review = L.layerGroup();
    this.reviewPairs = rounds.map((round) => {
      const colour = BAND_COLOR[round.band];
      const line = L.polyline([[round.guess.lat, round.guess.lon], [round.actual.lat, round.actual.lon]], {
        color: colour,
        weight: 2,
        opacity: 0.7,
        dashArray: '5 6',
        interactive: false,
      });
      const guess = L.marker([round.guess.lat, round.guess.lon], {
        icon: reviewDot('guess', round.band),
        keyboard: false,
        interactive: false,
      });
      const actual = L.marker([round.actual.lat, round.actual.lon], {
        icon: reviewDot('actual', round.band, round.name),
        keyboard: false,
        interactive: false,
      });
      // Lines first, so no line is drawn over a pin.
      this.review.addLayer(line);
      return { line, guess, actual };
    });
    for (const pair of this.reviewPairs) {
      this.review.addLayer(pair.guess);
      this.review.addLayer(pair.actual);
    }
    this.review.addTo(this.map);
  }

  /** Keeps fits clear of whatever chrome is currently over the map. */
  setReviewPadding(pad) {
    this.reviewPad = pad;
  }

  /** Frames the whole run. */
  fitReview({ animate = true } = {}) {
    if (!this.reviewPairs.length) return;
    const bounds = this.reviewPairs.reduce(
      (acc, pair) => acc.extend(pair.line.getBounds()),
      L.latLngBounds(this.reviewPairs[0].line.getBounds()),
    );
    this.map.fitBounds(bounds, {
      paddingTopLeft: this.reviewPad.topLeft,
      paddingBottomRight: this.reviewPad.bottomRight,
      maxZoom: 11,
      animate,
    });
  }

  /** Zooms to one round and lifts it above the rest. */
  focusReview(index) {
    const pair = this.reviewPairs[index];
    if (!pair) return;
    for (const [i, other] of this.reviewPairs.entries()) {
      const on = i === index;
      other.line.setStyle({ opacity: on ? 1 : 0.25, weight: on ? 3 : 2 });
      for (const marker of [other.guess, other.actual]) {
        marker.getElement()?.classList.toggle('is-dimmed', !on);
        marker.getElement()?.classList.toggle('is-focus', on);
      }
    }
    this.map.fitBounds(pair.line.getBounds(), {
      paddingTopLeft: this.reviewPad.topLeft,
      paddingBottomRight: this.reviewPad.bottomRight,
      maxZoom: 12,
      animate: true,
    });
  }

  /** Back to every round weighted the same. */
  unfocusReview() {
    for (const pair of this.reviewPairs) {
      pair.line.setStyle({ opacity: 0.7, weight: 2 });
      for (const marker of [pair.guess, pair.actual]) {
        marker.getElement()?.classList.remove('is-dimmed', 'is-focus');
      }
    }
  }

  /** Hides the run without throwing it away, so the imagery can be read. */
  setReviewVisible(visible) {
    if (!this.review) return;
    if (visible) this.review.addTo(this.map);
    else this.map.removeLayer(this.review);
  }

  clearReview() {
    if (this.review) this.map.removeLayer(this.review);
    this.review = null;
    this.reviewPairs = [];
  }

  clearRound() {
    for (const layer of [this.guessMarker, this.actualMarker, this.link]) {
      if (layer) this.map.removeLayer(layer);
    }
    this.guessMarker = null;
    this.actualMarker = null;
    this.link = null;
  }

  /** Frames a country, so a round starts from a sensible viewport. */
  frameCountry(bbox, { animate = true } = {}) {
    const [minLat, minLon, maxLat, maxLon] = bbox;
    this.map.fitBounds(
      [
        [minLat, minLon],
        [maxLat, maxLon],
      ],
      { padding: [70, 70], maxZoom: 9, animate },
    );
  }

  resetView() {
    this.map.setView([25, 10], 2.5, { animate: false });
  }
}
