import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadCatalogue } from './catalogue';
import './style.css';

const MIN_DISTANCE = 1;
const MAX_DISTANCE = 20_000;
const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
const distance = document.querySelector<HTMLOutputElement>('#distance')!;
const radius = document.querySelector<HTMLInputElement>('#radius')!;
const performanceText = document.querySelector<HTMLElement>('#performance')!;
const loading = document.querySelector<HTMLElement>('#loading')!;
const loadingText = document.querySelector<HTMLElement>('#loading-text')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

async function start() {
  const renderer = new THREE.WebGLRenderer({
    canvas, logarithmicDepthBuffer: true, antialias: false,
    powerPreference: 'high-performance',
  });
  // One physical pixel per CSS pixel: bound fill cost on high-DPI laptops.
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x05070b);
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

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  let stars = 0;
  let frames = 0;
  let lastSample = performance.now();
  let lastProgress = 0;
  renderer.setAnimationLoop((now) => {
    controls.update();
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
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.08,
    blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: false,
  });
  const streaks = new THREE.LineSegments(catalogue.geometry, material);
  streaks.matrixAutoUpdate = false;
  scene.add(streaks);
  // Present the loading message before the initial GPU upload.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  renderer.render(scene, camera);
  stars = catalogue.meta.stars;
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
