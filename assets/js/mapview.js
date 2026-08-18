/* global L */
/** Thin wrapper around the Leaflet map: basemap, pins, reveal animation. */

const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ATTRIBUTION =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

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
