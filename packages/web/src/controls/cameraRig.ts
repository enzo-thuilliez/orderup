/**
 * Two ways to look at the kitchen: an orbit overview and a first-person walk (WASD + pointer
 * lock). Tab toggles between them; each mode remembers where it was.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { slide, type Point } from '../logic/layout';

export type CameraMode = 'orbit' | 'walk';

const EYE_HEIGHT = 1.6;
const WALK_SPEED = 3.2;
const RUN_FACTOR = 1.8;
const TURN_SPEED = 2.2;
const ORBIT_TARGET = new THREE.Vector3(1.8, 0.6, -0.8);
const ORBIT_START = new THREE.Vector3(9, 9.5, 12.5);
const WALK_START = new THREE.Vector3(0, EYE_HEIGHT, 2.4);

export class CameraRig {
  mode: CameraMode = 'orbit';
  readonly orbit: OrbitControls;
  readonly look: PointerLockControls;
  private readonly keys = new Set<string>();
  private readonly orbitPose = { position: ORBIT_START.clone(), target: ORBIT_TARGET.clone() };
  private readonly walkPose = { position: WALK_START.clone(), quaternion: new THREE.Quaternion() };
  private readonly listeners = new Set<(mode: CameraMode) => void>();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
  ) {
    camera.position.copy(ORBIT_START);
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.target.copy(ORBIT_TARGET);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 5;
    this.orbit.maxDistance = 32;
    this.orbit.maxPolarAngle = Math.PI * 0.46;
    this.orbit.update();

    this.look = new PointerLockControls(camera, dom);
    this.look.enabled = false;
    // Start walking in the front aisle, facing the island cooks.
    const m = new THREE.Matrix4().lookAt(WALK_START, new THREE.Vector3(0, 1.1, -1.2), camera.up);
    this.walkPose.quaternion.setFromRotationMatrix(m);

    dom.addEventListener('click', () => {
      if (this.mode === 'walk' && !this.look.isLocked) this.lock();
    });
    this.look.addEventListener('lock', () => this.emit());
    this.look.addEventListener('unlock', () => this.emit());
  }

  onChange(fn: (mode: CameraMode) => void): void {
    this.listeners.add(fn);
  }

  get locked(): boolean {
    return this.look.isLocked;
  }

  toggle(): void {
    this.setMode(this.mode === 'orbit' ? 'walk' : 'orbit');
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    if (mode === 'walk') {
      this.orbitPose.position.copy(this.camera.position);
      this.orbitPose.target.copy(this.orbit.target);
      this.orbit.enabled = false;
      this.look.enabled = true;
      this.camera.position.copy(this.walkPose.position);
      this.camera.quaternion.copy(this.walkPose.quaternion);
      this.mode = 'walk';
      this.lock();
    } else {
      this.walkPose.position.copy(this.camera.position);
      this.walkPose.quaternion.copy(this.camera.quaternion);
      this.look.enabled = false;
      if (this.look.isLocked) this.look.unlock();
      this.camera.position.copy(this.orbitPose.position);
      this.orbit.target.copy(this.orbitPose.target);
      this.orbit.enabled = true;
      this.mode = 'orbit';
      this.orbit.update();
    }
    this.keys.clear();
    this.emit();
  }

  lock(): void {
    // Browsers refuse pointer lock without a user gesture (or in headless runs); walking still
    // works with the arrow keys, so a refusal is not an error.
    try {
      const p = this.dom.requestPointerLock() as unknown;
      if (p instanceof Promise) p.catch(() => {});
    } catch {
      // ignore
    }
  }

  unlock(): void {
    if (this.look.isLocked) this.look.unlock();
  }

  keyDown(code: string): void {
    this.keys.add(code);
  }

  keyUp(code: string): void {
    this.keys.delete(code);
  }

  releaseKeys(): void {
    this.keys.clear();
  }

  /** Walker position on the floor. */
  get feet(): Point {
    return { x: this.camera.position.x, z: this.camera.position.z };
  }

  /** Point on the floor a little ahead of the walker, to pick the cook being looked at. */
  lookPoint(distance: number): Point {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) return this.feet;
    dir.normalize();
    return {
      x: this.camera.position.x + dir.x * distance,
      z: this.camera.position.z + dir.z * distance,
    };
  }

  update(dt: number): void {
    if (this.mode === 'orbit') {
      this.orbit.update();
      return;
    }
    const k = this.keys;
    const turn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    if (turn) {
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      e.y += turn * TURN_SPEED * dt;
      this.camera.quaternion.setFromEuler(e);
    }
    const fwd =
      (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    if (!fwd && !side) return;
    const speed = WALK_SPEED * (k.has('ShiftLeft') || k.has('ShiftRight') ? RUN_FACTOR : 1) * dt;
    const len = Math.hypot(fwd, side);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up);
    const from = this.feet;
    const to = {
      x: from.x + ((forward.x * fwd + right.x * side) / len) * speed,
      z: from.z + ((forward.z * fwd + right.z * side) / len) * speed,
    };
    const next = slide(from, to);
    this.camera.position.set(next.x, EYE_HEIGHT, next.z);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.mode);
  }
}
