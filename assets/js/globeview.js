/* global Globe */
/**
 * Experimental 3D globe renderer — a drop-in alternative to MapView.
 *
 * Same surface as the Leaflet view (onPick, setPicking, showGuess, reveal,
 * clearRound, frameCountry, resetView) so main.js does not know which one it is
 * driving. Switch with ?renderer=globe.
 *
 * Built on globe.gl (MIT), which wraps three-globe and three.js. The imagery is
 * the same Esri tile service the flat map uses, fed through globe.gl's slippy
 * tile engine, so this changes how the world is drawn and nothing about what is
 * drawn on it: the dataset is lat/lon and the scoring is great-circle, neither
 * of which cares about the projection.
 */

const ESRI_IMAGERY = (x, y, level) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`;

const EARTH_RADIUS_KM = 6371;

/** Camera limits, in globe radii above the surface. */
const MIN_ALTITUDE = 0.08;
const MAX_ALTITUDE = 2.6;

/** Leaves room around a framed country instead of touching its edges. */
const FRAME_PADDING = 1.5;

const BORDER_LAYERS = [
  { url: 'data/borders/countries.json', color: 'rgba(255,255,255,0.95)', stroke: 0.9 },
  { url: 'data/borders/states.json', color: 'rgba(255,255,255,0.55)', stroke: 0.5 },
];

const wrap180 = (deg) => ((deg + 540) % 360) - 180;

function pin(kind, label) {
  const element = document.createElement('div');
  element.className = 'pin-marker';
  element.innerHTML =
    `<div class="pin pin-${kind}"></div>${label ? `<span class="pin-label">${label}</span>` : ''}`;
  return element;
}

/** Great-circle distance in degrees of arc. */
function arcDegrees(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / toRad;
}

export class GlobeView {
  constructor(elementId) {
    const container = document.getElementById(elementId);

    this.globe = new Globe(container, { animateIn: false })
      .globeTileEngineUrl(ESRI_IMAGERY)
      .backgroundColor('#070b12')
      .showAtmosphere(true)
      .atmosphereColor('#4cc2ff')
      .atmosphereAltitude(0.16)
      .htmlElementsData([])
      .htmlLat((d) => d.lat)
      .htmlLng((d) => d.lon)
      .htmlAltitude(0.01)
      .htmlElement((d) => d.element)
      .pathsData([])
      // Without this the layer treats each path object as the point array itself.
      .pathPoints((path) => path.points)
      .pathPointLat((p) => p[0])
      .pathPointLng((p) => p[1])
      .pathColor((path) => path.color)
      .pathStroke((path) => path.stroke)
      .pathTransitionDuration(0);

    const controls = this.globe.controls();
    controls.enablePan = false;
    controls.minDistance = 101;   // globe radius is 100, so this is 0.01 up
    controls.maxDistance = 360;
    controls.zoomSpeed = 0.6;
    // A globe that keeps turning under an unplaced pin is a moving target.
    controls.autoRotate = false;

    this.globe.onGlobeClick(({ lat, lng }) => {
      if (!this.pickingEnabled || !this.onPick) return;
      this.onPick({ lat, lon: wrap180(lng) });
    });

    this.markers = [];
    this.link = null;
    this.onPick = null;
    this.pickingEnabled = false;

    this.borders = null;
    this.bordersOn = false;
    this.bordersButton = this.addBordersControl(container);

    this.resize = () => this.globe.width(container.clientWidth).height(container.clientHeight);
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  /* ----------------------------------------------------------- borders */

  addBordersControl(container) {
    const bar = document.createElement('div');
    bar.className = 'globe-controls';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'borders-btn';
    button.title = 'Show country and state borders';
    button.textContent = 'Borders';
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => this.toggleBorders());
    bar.append(button);
    container.append(bar);
    return button;
  }

  async toggleBorders() {
    if (!this.borders) {
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
    this.bordersButton.classList.toggle('is-on', this.bordersOn);
    this.bordersButton.setAttribute('aria-pressed', String(this.bordersOn));
    this.drawPaths();
  }

  async loadBorders() {
    const layers = await Promise.all(
      BORDER_LAYERS.map(async ({ url, color, stroke }) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} (${res.status})`);
        const { coordinates } = await res.json();
        // GeoJSON is [lon, lat]; the path layer reads [lat, lon].
        return coordinates.map((line) => ({
          points: line.map(([lon, lat]) => [lat, lon]),
          color,
          stroke,
        }));
      }),
    );
    return layers.flat();
  }

  /** The paths layer carries both the borders and the guess→answer line. */
  drawPaths() {
    const paths = this.bordersOn && this.borders ? [...this.borders] : [];
    if (this.link) paths.push(this.link);
    this.globe.pathsData(paths);
  }

  /* -------------------------------------------------------------- round */

  setPicking(enabled) {
    this.pickingEnabled = enabled;
    document.getElementById('map').classList.toggle('is-idle', !enabled);
  }

  showGuess({ lat, lon }) {
    this.markers = this.markers.filter((m) => m.kind !== 'guess');
    this.markers.push({ kind: 'guess', lat, lon, element: pin('guess', 'You') });
    this.globe.htmlElementsData(this.markers);
  }

  reveal(guess, actual, label) {
    this.markers.push({
      kind: 'actual',
      lat: actual.lat,
      lon: actual.lon,
      element: pin('actual', label),
    });
    this.globe.htmlElementsData(this.markers);

    this.link = {
      points: [[guess.lat, guess.lon], [actual.lat, actual.lon]],
      color: 'rgba(255,255,255,0.85)',
      stroke: 0.6,
    };
    this.drawPaths();

    // Frame both pins: centre between them, far enough out to hold the gap.
    const midpoint = {
      lat: (guess.lat + actual.lat) / 2,
      lon: wrap180(guess.lon + wrap180(actual.lon - guess.lon) / 2),
    };
    this.lookAt(midpoint, arcDegrees(guess, actual) / 2, 900);
  }

  clearRound() {
    this.markers = [];
    this.link = null;
    this.globe.htmlElementsData([]);
    this.drawPaths();
  }

  /* ------------------------------------------------------------- camera */

  /**
   * Points the camera at a spot, far enough out to see `radiusDegrees` around
   * it. The visible cap from altitude `a` has half-angle acos(1 / (1 + a)), so
   * inverting that gives the altitude a given radius needs.
   */
  lookAt({ lat, lon }, radiusDegrees, transitionMs) {
    const padded = Math.min(Math.max(radiusDegrees, 0.5) * FRAME_PADDING, 75) * (Math.PI / 180);
    const altitude = Math.min(Math.max(1 / Math.cos(padded) - 1, MIN_ALTITUDE), MAX_ALTITUDE);
    this.globe.pointOfView({ lat, lng: lon, altitude }, transitionMs);
  }

  frameCountry(box, { animate = true } = {}) {
    const [minLat, minLon, maxLat, maxLon] = box;
    const centre = {
      lat: (minLat + maxLat) / 2,
      lon: wrap180(minLon + wrap180(maxLon - minLon) / 2),
    };
    // Radius to the farthest corner, so nothing sits outside the view.
    const radius = Math.max(
      ...[[minLat, minLon], [minLat, maxLon], [maxLat, minLon], [maxLat, maxLon]].map(
        ([lat, lon]) => arcDegrees(centre, { lat, lon }),
      ),
    );
    this.lookAt(centre, radius, animate ? 900 : 0);
  }

  resetView() {
    this.globe.pointOfView({ lat: 25, lng: 10, altitude: 2.4 }, 0);
  }
}

/** Kilometres per degree of arc, for anyone converting the two. */
export const KM_PER_DEGREE = (EARTH_RADIUS_KM * Math.PI) / 180;
