import { PROTOCOL_VERSION } from 'orderup-shared';
import * as THREE from 'three';
import { palette } from './palette';

// Stub scene: a warm floor and one station. The kitchen, cooks and controls arrive with feat(web).

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(palette.night);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

scene.add(new THREE.HemisphereLight(palette.ambient, palette.night, 0.9));
const lamp = new THREE.PointLight(palette.lampLight, 60, 20);
lamp.position.set(0, 4, 0);
lamp.castShadow = true;
scene.add(lamp);

const floor = new THREE.Mesh(
  new THREE.BoxGeometry(10, 0.2, 10),
  new THREE.MeshStandardMaterial({ color: palette.floorTile, flatShading: true }),
);
floor.position.y = -0.1;
floor.receiveShadow = true;
scene.add(floor);

const station = new THREE.Group();
const base = new THREE.Mesh(
  new THREE.BoxGeometry(2, 0.9, 0.8),
  new THREE.MeshStandardMaterial({ color: palette.counter, flatShading: true }),
);
base.position.y = 0.45;
const top = new THREE.Mesh(
  new THREE.BoxGeometry(2.1, 0.08, 0.9),
  new THREE.MeshStandardMaterial({ color: palette.counterTop, flatShading: true }),
);
top.position.y = 0.94;
const pot = new THREE.Mesh(
  new THREE.CylinderGeometry(0.22, 0.2, 0.3, 8),
  new THREE.MeshStandardMaterial({ color: palette.copper, flatShading: true }),
);
pot.position.set(0.4, 1.13, 0);
for (const mesh of [base, top, pot]) mesh.castShadow = true;
station.add(base, top, pot);
scene.add(station);

const hud = document.getElementById('hud');
if (hud) hud.textContent = `OrderUp: kitchen opening soon (protocol v${PROTOCOL_VERSION})`;

function resize(): void {
  const { clientWidth: w, clientHeight: h } = container;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop((ms) => {
  const t = ms / 1000;
  camera.position.set(Math.sin(t * 0.15) * 6, 3.5, Math.cos(t * 0.15) * 6);
  camera.lookAt(0, 0.8, 0);
  renderer.render(scene, camera);
});
