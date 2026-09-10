import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadCatalogue } from './catalogue';
import {
  createFlightPath, FlightClock, flightLookOffset, flightMorph, flightSubtitleAt,
  flightDip, flightTreatmentMix, FLIGHT_SECONDS, RECORD_FPS, RECORD_PIXEL_RATIO,
} from './flight';
import { drawOverlay } from './overlay';
import { rampGradient, temperatureForBpRp } from './palette';
import { createStarMaterial } from './starMaterial';
import { DEFAULT_TREATMENT, TREATMENTS } from './treatments';
import type { Treatment } from './treatments';
import './style.css';

const MIN_DISTANCE = 1;
const MAX_DISTANCE = 20_000;
const SWEEP_SECONDS = 9; // One end to the other. Slow enough to read on video.
const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
const distance = document.querySelector<HTMLOutputElement>('#distance')!;
const radius = document.querySelector<HTMLInputElement>('#radius')!;
const morphInput = document.querySelector<HTMLInputElement>('#morph')!;
const morphValue = document.querySelector<HTMLOutputElement>('#morph-value')!;
const morphNote = document.querySelector<HTMLElement>('#morph-note')!;
const sweepButton = document.querySelector<HTMLButtonElement>('#sweep')!;
const treatments = document.querySelector<HTMLFieldSetElement>('#treatments')!;
const treatmentNote = document.querySelector<HTMLElement>('#treatment-note')!;
const rampBar = document.querySelector<HTMLElement>('#ramp')!;
const rampTicks = document.querySelector<HTMLElement>('#ramp-ticks')!;
const performanceText = document.querySelector<HTMLElement>('#performance')!;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingText = document.querySelector<HTMLElement>('#loading-text')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const flightButton = document.querySelector<HTMLButtonElement>('#flight')!;
flightButton.textContent = `Fly · F · ${FLIGHT_SECONDS} seconds`;
const params = new URLSearchParams(window.location.search);
const recording = params.has('record');
// Export renders the film frame by frame and posts each to scripts/export.mjs.
// It never uses the wall clock, so the result does not depend on this machine.
const exporting = params.has('export');
const exportSize = {
  width: Math.round(Number(params.get('w')) || 1920),
  height: Math.round(Number(params.get('h')) || 1080),
  seconds: Math.min(Number(params.get('s')) || FLIGHT_SECONDS, FLIGHT_SECONDS),
};
if (recording) document.querySelector('#flight-note')!.textContent =
  `Recording · ${RECORD_FPS} fps · ${RECORD_PIXEL_RATIO}× sampling · F to restart · Esc to exit`;
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const nearFormat = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kelvin = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const PLATE = TREATMENTS.find((value) => value.id === 'plate')!;
const CONFIDENCE = TREATMENTS.find((value) => value.id === 'confidence')!;
/** The page's own readout. The film draws its own counter, in both units. */
const formatDistance = (pc: number) => `${(pc < 10 ? nearFormat : format).format(pc)} pc`;
const query = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

// Smoothstep and its inverse: the sweep eases in and out, and picking it up
// from wherever the slider was left needs the phase that produced that value.
const ease = (x: number) => x * x * (3 - 2 * x);
const unease = (y: number) => 0.5 - Math.sin(Math.asin(1 - 2 * THREE.MathUtils.clamp(y, 0, 1)) / 3);

/** Radio per treatment, drawn as a segmented control by the stylesheet. */
function buildTreatmentPicker(onChange: (treatment: Treatment) => void) {
  const group = document.createElement('div');
  for (const treatment of TREATMENTS) {
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'treatment';
    input.id = `treatment-${treatment.id}`;
    input.value = treatment.id;
    input.checked = treatment.id === DEFAULT_TREATMENT.id;
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = treatment.label;
    group.append(input, label);
  }
  group.addEventListener('change', (event) => {
    const id = (event.target as HTMLInputElement).value;
    const treatment = TREATMENTS.find((candidate) => candidate.id === id);
    if (treatment) onChange(treatment);
  });
  treatments.append(group);
}

/** Ticks read out of the same function the ramp is built from, so they agree. */
function buildRampTicks([low, high]: readonly [number, number]) {
  const marks: [number, string][] = [[low, ''], [0.82, ' ☉'], [high, '']];
  for (const [bpRp, suffix] of marks) {
    const tick = document.createElement('span');
    const fraction = (bpRp - low) / (high - low);
    tick.className = fraction <= 0 ? 'start' : fraction >= 1 ? 'end' : '';
    tick.style.left = `${fraction * 100}%`;
    const sign = bpRp > 0 ? '+' : bpRp < 0 ? '−' : '';
    tick.textContent =
      `${sign}${Math.abs(bpRp).toFixed(2)}${suffix} · ${kelvin.format(temperatureForBpRp(bpRp))} K`;
    rampTicks.append(tick);
  }
}

/**
 * The live overlay: the same painting routine the export uses, on a canvas
 * over the sky, plus a silent copy of the subtitle for assistive technology.
 */
function createOverlay() {
  const element = query<HTMLCanvasElement>('#overlay');
  const ctx = element.getContext('2d')!;
  const live = query('#subtitle-live');
  let spoken = '';
  return {
    resize(pixelRatio: number) {
      element.width = Math.round(window.innerWidth * pixelRatio);
      element.height = Math.round(window.innerHeight * pixelRatio);
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    },
    update(seconds: number, pc: number) {
      const cue = flightSubtitleAt(seconds);
      // This canvas is the overlay's own surface, so it clears it itself.
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      drawOverlay(ctx, window.innerWidth, window.innerHeight, cue, pc, flightDip(seconds));
      if (cue.text !== spoken) {
        spoken = cue.text;
        live.textContent = cue.text;
      }
    },
    clear() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      spoken = '';
      live.textContent = '';
    },
  };
}

/**
 * The two cards fold to their heads. A phone has room for the sky or for the
 * panels, not both, so there both start folded and opening one folds the
 * other; a desktop has room for both and opens both.
 *
 * The default is read once, at load. After that the fold is the viewer's, and
 * a rotation is not a reason to overrule them.
 */
const NARROW = window.matchMedia('(max-width: 600px)');

function setCardOpen(card: HTMLElement, open: boolean) {
  const head = card.querySelector<HTMLButtonElement>('.card-head')!;
  card.dataset.open = String(open);
  head.setAttribute('aria-expanded', String(open));
  query(`#${head.getAttribute('aria-controls')}`).hidden = !open;
}

function setupCards() {
  const cards = [...document.querySelectorAll<HTMLElement>('[data-open]')];
  for (const card of cards) {
    card.querySelector<HTMLButtonElement>('.card-head')!.addEventListener('click', () => {
      const open = card.dataset.open !== 'true';
      setCardOpen(card, open);
      if (!open || !NARROW.matches) return;
      for (const other of cards) if (other !== card) setCardOpen(other, false);
    });
    setCardOpen(card, !NARROW.matches);
  }
}
setupCards();

/** Counts come from the packer's own summary; with no summary, no percentage. */
function labelKey(id: string, text: string, count: number | undefined, stars: number) {
  const share = count === undefined ? '' : ` · ${(count / stars * 100).toFixed(1)}%`;
  document.querySelector<HTMLElement>(id)!.textContent = text + share;
}

async function start() {
  const renderer = new THREE.WebGLRenderer({
    canvas, logarithmicDepthBuffer: true, antialias: false,
    powerPreference: 'high-performance',
    // The export composites the rendered frame into a 2D canvas; without this
    // the buffer may already be gone by the time it is read.
    preserveDrawingBuffer: exporting,
  });
  // Interactive mode stays cheap. Recording spends 4× the pixels on thin lines.
  renderer.setPixelRatio(recording ? RECORD_PIXEL_RATIO : 1);
  const scene = new THREE.Scene();
  // A 0.001 pc near plane keeps close crossings visible. Leave line clipping
  // to the GPU: clamping a vertex onto the plane would deform measured rays.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.001, 50_000);
  camera.up.set(0, 0, 1); // ICRS north is +Z.
  camera.position.set(0, -1_000, 0);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enablePan = false; // Radius limits must remain distances from Earth.
  controls.minDistance = MIN_DISTANCE;
  controls.maxDistance = MAX_DISTANCE;
  controls.enableDamping = true;
  controls.zoomSpeed = 1.5;
  controls.update();

  let treatment = DEFAULT_TREATMENT;
  let field: ReturnType<typeof createStarMaterial> | null = null;
  let morph = Number(morphInput.value);
  let sweeping = false;
  let sweepPhase = unease(morph);
  let flight: FlightClock | null = null;
  let holdingFlight = false;
  let ready = false;
  const flightPath = createFlightPath();
  const flightTarget = new THREE.Vector3();
  const overlay = createOverlay();
  const plateGround = new THREE.Color(PLATE.ground);
  const confidenceGround = new THREE.Color(CONFIDENCE.ground);
  const flightGround = new THREE.Color();
  let savedTreatment: Treatment | null = null;

  function applyTreatment(next: Treatment) {
    treatment = next;
    document.documentElement.dataset.treatment = next.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next.ground);
    renderer.setClearColor(next.ground);
    treatmentNote.textContent = next.note;
    document.querySelector<HTMLInputElement>(`#treatment-${next.id}`)!.checked = true;
    field?.setTreatment(next);
    if (field) rampBar.style.background = rampGradient(field.ramp);
  }

  function applyMorph(value: number) {
    morph = THREE.MathUtils.clamp(value, 0, 1);
    morphInput.value = String(morph);
    morphValue.textContent = morph.toFixed(3);
    morphInput.setAttribute('aria-valuetext', `${morph.toFixed(3)} of the measured bounds`);
    // The caveat about a centred fraction is only true off the bound, so it is only
    // shown there. A warning about a state the viewer is not in is one they learn
    // to skip, and this one has to still be read at 0.999.
    morphNote.hidden = morph >= 1;
    field?.setMorph(morph);
  }

  function setSweeping(active: boolean) {
    sweeping = active;
    sweepButton.setAttribute('aria-pressed', String(active));
    if (active) sweepPhase = unease(morph);
  }

  /** Places the whole film at one time. Returns the camera's distance. */
  function applyFlightFrame(seconds: number): number {
    flightPath.positionAt(seconds, camera.position);
    camera.lookAt(flightPath.targetAt(seconds, flightTarget));
    camera.rotateY(flightLookOffset(seconds));
    morph = flightMorph(seconds);
    field?.setMorph(morph);
    const mix = flightTreatmentMix(seconds);
    field?.setTreatmentBlend(PLATE, CONFIDENCE, mix);
    renderer.setClearColor(flightGround.copy(plateGround).lerp(confidenceGround, mix));
    const parsecs = camera.position.length();
    field?.setViewDistance(parsecs);
    return parsecs;
  }

  function stopFlight(completed = holdingFlight) {
    flight = null;
    holdingFlight = false;
    document.body.classList.remove('flight-playing');
    overlay.clear();
    controls.enabled = true;
    controls.update();
    if (savedTreatment) applyTreatment(completed ? CONFIDENCE : savedTreatment);
    savedTreatment = null;
    applyMorph(morph);
    updateReadout();
    frames = 0;
    lastSample = lastFrame = performance.now();
  }

  function startFlight() {
    if (!ready) return;
    if (!flight && !holdingFlight) savedTreatment = treatment;
    setSweeping(false);
    applyTreatment(PLATE);
    // Drain any existing orbit inertia before the scripted placement. Calling
    // update during flight would overwrite the spline and reapply radius limits.
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = true;
    controls.enabled = false;
    controls.target.set(0, 0, 0);
    (document.activeElement as HTMLElement | null)?.blur();
    holdingFlight = false;
    flight = new FlightClock(recording);
    document.body.classList.add('flight-playing');
  }

  flightButton.addEventListener('click', startFlight);
  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement &&
        (target.isContentEditable || target.matches(
          'input:not([type="range"]):not([type="radio"]):not([type="checkbox"]), textarea, select',
        ))) return;
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      startFlight();
    } else if (event.key === 'Escape' && (flight || holdingFlight)) {
      event.preventDefault();
      stopFlight();
    }
  });

  buildTreatmentPicker(applyTreatment);
  applyTreatment(treatment);
  applyMorph(morph);

  morphInput.addEventListener('input', () => {
    setSweeping(false);
    applyMorph(Number(morphInput.value));
  });
  sweepButton.addEventListener('click', () => setSweeping(!sweeping));
  document.querySelector('#collapse')!.addEventListener('click', () => {
    setSweeping(false);
    applyMorph(0);
  });
  document.querySelector('#expand')!.addEventListener('click', () => {
    setSweeping(false);
    applyMorph(1);
  });

  function updateReadout() {
    const pc = camera.position.length();
    distance.value = formatDistance(pc);
    radius.value = String(Math.log(pc) / Math.log(MAX_DISTANCE));
    radius.setAttribute('aria-valuetext', distance.value);
  }
  function setDistance(pc: number) {
    // Flush pending damping before placing the camera precisely at a limit.
    controls.enableDamping = false;
    controls.update();
    camera.position.setLength(THREE.MathUtils.clamp(pc, MIN_DISTANCE, MAX_DISTANCE));
    controls.update();
    controls.enableDamping = true;
    updateReadout();
  }
  controls.addEventListener('change', updateReadout);
  radius.addEventListener('input', () => setDistance(MAX_DISTANCE ** Number(radius.value)));
  document.querySelector('#near')!.addEventListener('click', () => setDistance(MIN_DISTANCE));
  document.querySelector('#far')!.addEventListener('click', () => setDistance(MAX_DISTANCE));
  updateReadout();

  const buffer = new THREE.Vector2();
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(buffer);
    field?.setViewport(buffer.x, buffer.y, camera.near, renderer.getPixelRatio());
    // The sky's pixel ratio is a performance choice; the overlay's is not. A
    // dozen glyphs cost nothing to draw at the display's own resolution, and
    // below it the type is visibly resampled by the browser. Recording's 2x
    // stands where it is the higher of the two, so a capture keeps its
    // supersampled text.
    overlay.resize(Math.max(window.devicePixelRatio, renderer.getPixelRatio()));
    if (holdingFlight) renderer.render(scene, camera);
  }
  window.addEventListener('resize', resize);
  resize();

  let stars = 0;
  let frames = 0;
  let lastSample = performance.now();
  let lastFrame = lastSample;
  let lastProgress = 0;
  renderer.setAnimationLoop((now) => {
    if (document.hidden || holdingFlight) return;
    const delta = Math.min((now - lastFrame) / 1_000, 0.1);
    lastFrame = now;
    let flightFinished = false;
    if (flight) {
      const seconds = flight.sample(now);
      if (seconds === null) return;
      const parsecs = applyFlightFrame(seconds);
      updateReadout();
      overlay.update(seconds, parsecs);
      flightFinished = seconds === FLIGHT_SECONDS;
    } else if (sweeping) {
      sweepPhase = (sweepPhase + delta / SWEEP_SECONDS) % 2;
      applyMorph(ease(sweepPhase <= 1 ? sweepPhase : 2 - sweepPhase));
    }
    if (!flight) {
      controls.update();
      // The distance falloff is relative to the orbit radius, so it has to
      // track the camera rather than being set once.
      field?.setViewDistance(camera.position.length());
    }
    renderer.render(scene, camera);
    if (flightFinished) {
      if (recording) {
        flight = null;
        holdingFlight = true; // Clean final frame until Esc, or F for another take.
      } else stopFlight(true);
    }
    frames++;
    const elapsed = now - lastSample;
    if (elapsed >= 1_000) {
      if (stars) performanceText.textContent =
        `${format.format(stars)} segments · ${(frames * 1_000 / elapsed).toFixed(1)} fps · ` +
        `${renderer.info.render.calls} draw call · ${renderer.domElement.width} × ${renderer.domElement.height}`;
      frames = 0;
      lastSample = now;
    }
  });
  document.addEventListener('visibilitychange', () => {
    flight?.pause();
    frames = 0;
    lastSample = performance.now();
    lastFrame = performance.now();
  });
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    ready = false;
    flightButton.disabled = true;
    stopFlight(false);
    loading.hidden = false;
    progress.hidden = true;
    loadingText.textContent = 'Graphics context lost. Reload this page to restore the catalogue.';
  });

  const catalogue = await loadCatalogue((loaded, total) => {
    const now = performance.now();
    if (now - lastProgress < 100 && loaded !== total && loaded !== 0) return;
    lastProgress = now;
    progress.max = total;
    progress.value = loaded;
    loadingText.textContent = loaded === total ? 'Preparing GPU buffers…' :
      `Loading catalogue · ${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB · ${Math.floor(loaded / total * 100)}%`;
  });
  camera.far = Math.max(50_000, MAX_DISTANCE + catalogue.meta.bounding_radius_pc * 1.01);
  camera.updateProjectionMatrix();

  const { meta } = catalogue;
  const bpRpDomain = meta.decode.color.domain;
  field = createStarMaterial({ bpRpDomain, treatment });
  field.prepareTreatments([PLATE, CONFIDENCE]);
  const streaks = new THREE.LineSegments(catalogue.geometry, field.material);
  streaks.matrixAutoUpdate = false;
  streaks.frustumCulled = false; // One object holding the whole sky; never cull it.
  scene.add(streaks);

  applyTreatment(treatment);
  applyMorph(morph);
  resize();
  buildRampTicks(bpRpDomain);
  const counts = meta.stats;
  labelKey('#key-measured', 'Far endpoint measured', counts?.far_measured, meta.stars);
  labelKey('#key-clamped', 'Far endpoint clamped, dissolves',
    counts && counts.far_clamped + counts.far_unbounded, meta.stars);
  labelKey('#key-stippled', 'No BP−RP, stippled', counts?.bp_rp_missing, meta.stars);

  /**
   * Render the film frame by frame and post each one to the export script.
   *
   * Nothing here reads a clock. Frame n is film second n / RECORD_FPS, so the
   * result is identical on any machine and cannot drop or duplicate a frame;
   * a slow machine only makes the export take longer. The sky is drawn at
   * RECORD_PIXEL_RATIO and downsampled into the film canvas, which is the
   * same supersampling the on-screen recording mode uses.
   */
  async function exportFilm() {
    const { width, height, seconds: filmSeconds } = exportSize;
    renderer.setAnimationLoop(null);
    controls.enabled = false;
    applyTreatment(PLATE);
    renderer.setPixelRatio(RECORD_PIXEL_RATIO);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(buffer);
    field?.setViewport(buffer.x, buffer.y, camera.near, renderer.getPixelRatio());
    const film = document.createElement('canvas');
    film.width = width;
    film.height = height;
    const ctx = film.getContext('2d')!;
    const total = Math.round(filmSeconds * RECORD_FPS);
    loading.hidden = false;
    progress.hidden = false;
    progress.max = total;
    for (let frame = 0; frame < total; frame++) {
      const seconds = frame / RECORD_FPS;
      const parsecs = applyFlightFrame(seconds);
      renderer.render(scene, camera);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(canvas, 0, 0, width, height);
      drawOverlay(ctx, width, height,
        flightSubtitleAt(seconds), parsecs, flightDip(seconds));
      const blob = await new Promise<Blob | null>((resolve) => film.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(`Frame ${frame} failed to encode`);
      // Awaiting each frame is the backpressure: the script only answers once
      // the bytes are in the encoder, so frames arrive in order and in step.
      const response = await fetch(`/frame/${frame}`, { method: 'POST', body: blob });
      if (!response.ok) throw new Error(`Frame ${frame}: ${await response.text()}`);
      progress.value = frame + 1;
      loadingText.textContent =
        `Exporting ${width} × ${height} · frame ${frame + 1} of ${total} · ` +
        `${((frame + 1) / total * 100).toFixed(1)}%`;
    }
    await fetch('/done', { method: 'POST' });
    progress.hidden = true;
    loadingText.textContent = 'Export complete. The script is finishing the file; this tab can be closed.';
  }

  if (exporting) {
    stars = meta.stars;
    await exportFilm().catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      loadingText.textContent = `Export failed: ${message}`;
      await fetch('/error', { method: 'POST', body: message }).catch(() => {});
      throw error;
    });
    return;
  }

  // Present the loading message before the initial GPU upload.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  renderer.render(scene, camera);
  stars = meta.stars;
  frames = 0;
  lastSample = performance.now();
  loading.hidden = true;
  ready = true;
  flightButton.disabled = false;
}

start().catch((error: unknown) => {
  loading.hidden = false;
  progress.hidden = true;
  loadingText.textContent = `Could not load sky: ${error instanceof Error ? error.message : String(error)}`;
  performanceText.textContent = 'Catalogue unavailable';
  console.error(error);
});
