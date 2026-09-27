/**
 * Steam over the stations of working cooks. One instanced mesh for the whole kitchen, so twenty
 * steaming cooks cost a single draw call.
 */
import * as THREE from 'three';
import { STEAM_PUFFS, steamPuff } from '../logic/anim';
import type { Point } from '../logic/layout';
import { palette } from '../palette';
import { COUNTER_HEIGHT } from './kitchen';

/** Steaming cooks drawn at once; past this, extra cooks simply get no steam. */
const MAX_SOURCES = 40;
/** How far in front of the cook the pot or board sits. */
const REACH = 0.75;

const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

export class Steam {
  readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private used = 0;

  constructor() {
    const material = new THREE.MeshStandardMaterial({
      color: palette.steam,
      flatShading: true,
      roughness: 1,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      material,
      MAX_SOURCES * STEAM_PUFFS,
    );
    this.mesh.name = 'steam';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < this.mesh.count; i++) this.mesh.setMatrixAt(i, hidden);
  }

  /** Start a frame: every puff hidden until `add` places it. */
  begin(): void {
    this.used = 0;
  }

  /** Steam for a cook standing at `pos` facing `heading`. */
  add(pos: Point, heading: number, t: number, seed: number): void {
    if (this.used >= MAX_SOURCES) return;
    const x = pos.x + Math.sin(heading) * REACH;
    const z = pos.z + Math.cos(heading) * REACH;
    for (let i = 0; i < STEAM_PUFFS; i++) {
      const p = steamPuff(i, t, seed);
      this.m.makeScale(p.scale, p.scale, p.scale);
      this.m.setPosition(x + p.dx, COUNTER_HEIGHT + 0.12 + p.y, z);
      this.mesh.setMatrixAt(this.used * STEAM_PUFFS + i, this.m);
    }
    this.used++;
  }

  /** Hide the puffs nobody claimed this frame and upload. */
  end(): void {
    for (let i = this.used * STEAM_PUFFS; i < this.mesh.count; i++) {
      this.mesh.setMatrixAt(i, hidden);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
