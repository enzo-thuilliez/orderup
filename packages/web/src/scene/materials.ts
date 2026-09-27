import * as THREE from 'three';

const cache = new Map<string, THREE.MeshStandardMaterial>();

/** Shared flat-shaded material for a palette colour. Don't mutate: use `ownMat` for that. */
export function mat(color: number, opts: { emissive?: number; roughness?: number } = {}) {
  const key = `${color}:${opts.emissive ?? ''}:${opts.roughness ?? ''}`;
  let m = cache.get(key);
  if (!m) {
    m = ownMat(color, opts);
    cache.set(key, m);
  }
  return m;
}

/** A material of your own, safe to tint or fade. */
export function ownMat(color: number, opts: { emissive?: number; roughness?: number } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: opts.roughness ?? 0.85,
    metalness: 0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissive ? 1 : 0,
  });
}

/** A mesh that casts and receives shadows. */
export function mesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const boxCache = new Map<string, THREE.BoxGeometry>();

/** Shared box geometry of a given size. */
export function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w}:${h}:${d}`;
  let g = boxCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    boxCache.set(key, g);
  }
  return g;
}

/** A box whose bottom sits at `y`. */
export function box(
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  return mesh(boxGeo(w, h, d), material, x, y + h / 2, z);
}
