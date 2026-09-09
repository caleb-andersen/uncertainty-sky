import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadCatalogue } from './catalogue';
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
const sweepButton = document.querySelector<HTMLButtonElement>('#sweep')!;
const treatments = document.querySelector<HTMLFieldSetElement>('#treatments')!;
const treatmentNote = document.querySelector<HTMLElement>('#treatment-note')!;
const rampBar = document.querySelector<HTMLElement>('#ramp')!;
const rampTicks = document.querySelector<HTMLElement>('#ramp-ticks')!;
const performanceText = document.querySelector<HTMLElement>('#performance')!;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingText = document.querySelector<HTMLElement>('#loading-text')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const kelvin = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

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

/** Counts come from the packer's own summary; with no summary, no percentage. */
function labelKey(id: string, text: string, count: number | undefined, stars: number) {
  const share = count === undefined ? '' : ` · ${(count / stars * 100).toFixed(1)}%`;
  document.querySelector<HTMLElement>(id)!.textContent = text + share;
}

async function start() {
  const renderer = new THREE.WebGLRenderer({
    canvas, logarithmicDepthBuffer: true, antialias: false,
    powerPreference: 'high-performance',
  });
  // One physical pixel per CSS pixel: bound fill cost on high-DPI laptops.
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50_000);
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

  function applyTreatment(next: Treatment) {
    treatment = next;
    document.documentElement.dataset.treatment = next.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next.ground);
    renderer.setClearColor(next.ground);
    treatmentNote.textContent = next.note;
    field?.setTreatment(next);
    if (field) rampBar.style.background = rampGradient(field.ramp);
  }

  function applyMorph(value: number) {
    morph = THREE.MathUtils.clamp(value, 0, 1);
    morphInput.value = String(morph);
    morphValue.textContent = morph.toFixed(3);
    morphInput.setAttribute('aria-valuetext', `${morph.toFixed(3)} of the measured bounds`);
    field?.setMorph(morph);
  }

  function setSweeping(active: boolean) {
    sweeping = active;
    sweepButton.setAttribute('aria-pressed', String(active));
    if (active) sweepPhase = unease(morph);
  }

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
    distance.value = `${format.format(pc)} pc`;
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
    field?.setViewport(buffer.x, buffer.y, camera.near);
  }
  window.addEventListener('resize', resize);
  resize();

  let stars = 0;
  let frames = 0;
  let lastSample = performance.now();
  let lastFrame = lastSample;
  let lastProgress = 0;
  renderer.setAnimationLoop((now) => {
    const delta = Math.min((now - lastFrame) / 1_000, 0.1);
    lastFrame = now;
    if (sweeping) {
      sweepPhase = (sweepPhase + delta / SWEEP_SECONDS) % 2;
      applyMorph(ease(sweepPhase <= 1 ? sweepPhase : 2 - sweepPhase));
    }
    controls.update();
    // The distance falloff is relative to the orbit radius, so it has to track
    // the camera rather than being set once.
    field?.setViewDistance(camera.position.length(), treatment);
    renderer.render(scene, camera);
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
    frames = 0;
    lastSample = performance.now();
    lastFrame = performance.now();
  });
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
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

  // Present the loading message before the initial GPU upload.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  renderer.render(scene, camera);
  stars = meta.stars;
  frames = 0;
  lastSample = performance.now();
  loading.hidden = true;
}

start().catch((error: unknown) => {
  loading.hidden = false;
  progress.hidden = true;
  loadingText.textContent = `Could not load sky: ${error instanceof Error ? error.message : String(error)}`;
  performanceText.textContent = 'Catalogue unavailable';
  console.error(error);
});
