import type { ServerMessage } from 'orderup-shared';
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CameraRig } from './controls/cameraRig';
import { DemoFeed, isDemo } from './demo/script';
import { displayName, nearest } from './logic/cook';
import { Connection, socketUrl } from './net/connection';
import { applyMessage, initialState, withStatus, type ConnectionStatus } from './net/store';
import { css, palette } from './palette';
import { Cooks } from './scene/cooks';
import { buildKitchen } from './scene/kitchen';
import { Hud, hudText } from './ui/hud';
import { Panel } from './ui/panel';

/** How close (m) a cook must be to the spot in front of the walker to be waved at or opened. */
const REACH = 2.4;

const root = document.documentElement.style;
for (const [name, hex] of Object.entries({
  night: palette.night,
  cream: palette.cream,
  copper: palette.copper,
  tomato: palette.tomato,
  ticket: palette.ticket,
  ink: palette.ticketInk,
  leaf: palette.leaf,
  brass: palette.brass,
  steel: palette.steel,
})) {
  root.setProperty(`--${name}`, css(hex));
}

const container = document.getElementById('app')!;
const overlay = document.getElementById('overlay')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
container.appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(palette.night);
scene.fog = new THREE.Fog(palette.night, 28, 60);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
const kitchen = buildKitchen();
scene.add(kitchen.group);
const cooks = new Cooks(scene, kitchen.rail);
const rig = new CameraRig(camera, renderer.domElement);
const hud = new Hud(overlay);
const panel = new Panel(overlay);

// --- Data: the server's WebSocket, or the scripted demo ---------------------------------------

const demo = isDemo(location.search);
let state = initialState(demo ? 'demo' : 'connecting');
let dirty = true;

function dispatch(msg: ServerMessage): void {
  state = applyMessage(state, msg);
  dirty = true;
}

function setStatus(status: ConnectionStatus): void {
  state = withStatus(state, status);
  dirty = true;
}

if (demo) {
  new DemoFeed(dispatch).start();
} else {
  const conn = new Connection({
    url: socketUrl(location),
    onMessage: dispatch,
    onStatus: setStatus,
  });
  conn.start();
}

function refresh(): void {
  dirty = false;
  cooks.sync(state.sessions);
  panel.update(state.sessions, Date.now());
  hud.setText(hudText(state.status, state.sessions.size, { serverProtocol: state.serverProtocol }));
}

// --- Input -------------------------------------------------------------------------------------

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
]);

/** The cook in front of the walker, if any. */
function focusedCook(): string | null {
  if (rig.mode !== 'walk') return null;
  return nearest(rig.lookPoint(1.4), cooks.list(), REACH);
}

function openPanel(id: string): void {
  const session = state.sessions.get(id);
  if (!session) return;
  panel.open(session, Date.now());
  rig.releaseKeys();
  rig.unlock();
}

rig.onChange((mode) => hud.setMode(mode, rig.locked));
hud.setMode(rig.mode, false);

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.code === 'Tab') {
    e.preventDefault();
    panel.close();
    rig.toggle();
    return;
  }
  if (typing) return;
  if (e.code === 'Escape') {
    panel.close();
    return;
  }
  if (rig.mode !== 'walk') return;
  if (e.code === 'KeyE' && !e.repeat) {
    const id = focusedCook();
    if (id) cooks.wave(id, rig.feet);
    return;
  }
  if (e.code === 'KeyF' && !e.repeat) {
    if (panel.openId) {
      panel.close();
      rig.lock();
      return;
    }
    const id = focusedCook();
    if (id) openPanel(id);
    return;
  }
  if (MOVE_KEYS.has(e.code) && !panel.openId) {
    e.preventDefault();
    rig.keyDown(e.code);
  }
});
window.addEventListener('keyup', (e) => rig.keyUp(e.code));
window.addEventListener('blur', () => rig.releaseKeys());

// Click a cook in the overview to open its panel (a drag is an orbit, not a click).
const down = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (e) => down.set(e.clientX, e.clientY));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (rig.mode !== 'orbit' || down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const id = cooks.pick(ray);
  if (id) openPanel(id);
  else panel.close();
});

// --- Loop --------------------------------------------------------------------------------------

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
// Skips the time spent in a background tab instead of fast-forwarding through it.
timer.connect(document);
let elapsed = 0;
let panelTick = 0;
let lastFocus: string | null = null;

renderer.setAnimationLoop((now) => {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.25);
  elapsed += dt;
  if (dirty) refresh();

  panelTick += dt;
  if (panelTick > 0.5) {
    panelTick = 0;
    panel.update(state.sessions, Date.now());
  }

  rig.update(dt);
  cooks.update(dt);
  let ringing = false;
  for (const s of state.sessions.values()) if (s.state === 'waiting') ringing = true;
  kitchen.update(elapsed, ringing);
  kitchen.fadeWalls(camera.position, rig.mode === 'orbit');

  const focus = panel.openId ? null : focusedCook();
  if (focus !== lastFocus) {
    lastFocus = focus;
    cooks.setFocus(focus);
    const s = focus ? state.sessions.get(focus) : undefined;
    hud.setPrompt(s ? displayName(s) : null);
  }

  renderer.render(scene, camera);
  labels.render(scene, camera);
});
