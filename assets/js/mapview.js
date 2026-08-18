/* global L */
/** Thin wrapper around the Leaflet map: basemap, pins, reveal animation. */

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const BORDER_LAYERS = [
  // Country lines carry the answer to "which country am I in", so they are the
  // ones you should be able to read at a glance. States are an aid, not the
  // subject, and stay faint enough not to compete with them.
  { name: 'countries', url: 'data/borders/countries.json', style: { color: '#ffffff', weight: 1.1, opacity: 0.75 } },
  { name: 'states', url: 'data/borders/states.json', style: { color: '#ffffff', weight: 0.7, opacity: 0.3, dashArray: '3 4' } },
];

function dot(kind, label) {
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}"></div>${label ? `<span class="pin-label">${label}</span>` : ''}`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
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
