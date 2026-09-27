/**
 * A procedural low-poly cook: round head, big toque, apron in the cook's colour, stubby arms.
 * `animate` drives the limbs for a pose; the caller decides position and heading.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BELL_PERIOD, blendInto, smoothing, type Carry, type Motion } from '../logic/anim';
import { palette } from '../palette';
import { boxGeo, mat, mesh, ownMat } from './materials';
import { COUNTER_HEIGHT } from './kitchen';

export type { Motion };

/** How fast limbs blend into a new pose (1/s): about 0.25 s from one pose to the next. */
const BLEND_RATE = 12;

/** Per-limb angles in radians. Arms hang down at 0; negative `x` lifts them forward. */
export interface Limbs {
  rightX: number;
  rightZ: number;
  leftX: number;
  leftZ: number;
  legSwing: number;
  bob: number;
  headX: number;
  headZ: number;
}

const REST: Limbs = {
  rightX: 0,
  rightZ: -0.12,
  leftX: 0,
  leftZ: 0.12,
  legSwing: 0,
  bob: 0,
  headX: 0,
  headZ: 0,
};

/** Limb angles for a motion at time `t` (seconds). Pure, so poses are easy to tweak. */
export function limbsFor(motion: Motion, t: number, waving: boolean): Limbs {
  const l: Limbs = { ...REST };
  switch (motion) {
    case 'walk': {
      const s = Math.sin(t * 9);
      l.legSwing = s * 0.55;
      l.rightX = s * 0.5;
      l.leftX = -s * 0.5;
      l.bob = Math.abs(Math.cos(t * 9)) * 0.05;
      break;
    }
    case 'chop': {
      l.rightX = -1.25 + Math.max(0, Math.sin(t * 13)) * 0.45;
      l.leftX = -0.9;
      l.leftZ = -0.25;
      l.headX = 0.25;
      l.bob = Math.max(0, Math.sin(t * 13)) * 0.015;
      break;
    }
    case 'stir': {
      l.rightX = -1.2 + Math.cos(t * 5) * 0.18;
      l.rightZ = 0.15 + Math.sin(t * 5) * 0.25;
      l.leftX = -0.5;
      l.headX = 0.2;
      l.headZ = Math.sin(t * 2.5) * 0.08;
      break;
    }
    case 'taste': {
      // Spoon to the mouth, pause, back to the pot.
      const c = (t % 2.4) / 2.4;
      const up = c < 0.5 ? Math.sin(c * 2 * Math.PI) : 0;
      l.rightX = -1.1 - up * 1.3;
      l.rightZ = 0.2 * up;
      l.leftX = -0.35;
      l.headX = 0.15 - up * 0.3;
      l.headZ = up * 0.12;
      break;
    }
    case 'read': {
      l.rightX = -1.3;
      l.rightZ = 0.25;
      l.leftX = -1.3;
      l.leftZ = -0.25;
      l.headX = 0.35 + Math.sin(t * 1.5) * 0.05;
      l.headZ = Math.sin(t * 0.8) * 0.1;
      break;
    }
    case 'direct': {
      l.rightX = -1.55;
      l.rightZ = -0.3 + Math.sin(t * 3) * 0.3;
      l.leftX = 0.1;
      l.bob = Math.abs(Math.sin(t * 6)) * 0.02;
      l.headZ = Math.sin(t * 3) * 0.1;
      break;
    }
    case 'bell': {
      // Two quick taps every bell period.
      const c = t % BELL_PERIOD;
      const tap = c < 0.5 ? Math.abs(Math.sin(c * 2 * Math.PI * 2)) : 0;
      l.rightX = -1.05 - (1 - tap) * 0.35;
      l.rightZ = 0.3;
      l.leftX = 0;
      l.leftZ = 0.35 + Math.sin(t * 4) * 0.05;
      l.headX = -0.1;
      l.bob = Math.abs(Math.sin(t * 5)) * 0.03;
      break;
    }
    case 'plate': {
      l.rightX = -1.45 + Math.sin(t * 2) * 0.05;
      l.rightZ = 0.15;
      l.leftX = -1.45 + Math.sin(t * 2) * 0.05;
      l.leftZ = -0.15;
      l.headX = -0.1;
      l.bob = Math.abs(Math.sin(t * 3)) * 0.025;
      break;
    }
    case 'sip': {
      const c = (t % 3.5) / 3.5;
      const up = c < 0.35 ? Math.sin((c / 0.35) * Math.PI) : 0;
      l.rightX = -0.8 - up * 1.1;
      l.rightZ = 0.25 + up * 0.15;
      l.leftZ = 0.18;
      l.headX = -up * 0.25;
      l.bob = Math.sin(t * 1.2) * 0.01;
      break;
    }
    case 'stretch': {
      // Mug still in hand: both arms up, lean back, then settle.
      const up = Math.sin(Math.min(1, (t % 4) / 1.6) * Math.PI);
      l.rightX = -0.3 - up * 2.4;
      l.rightZ = -0.2 - up * 0.3;
      l.leftX = -0.3 - up * 2.4;
      l.leftZ = 0.2 + up * 0.3;
      l.headX = -up * 0.35;
      l.bob = up * 0.03;
      break;
    }
    case 'gaze': {
      // Mug held low, looking around the patio.
      l.rightX = -0.8;
      l.rightZ = 0.25;
      l.leftZ = 0.18;
      l.headZ = Math.sin(t * 0.9) * 0.12;
      l.headX = -0.1 + Math.sin(t * 0.6) * 0.05;
      l.bob = Math.sin(t * 1.2) * 0.01;
      break;
    }
    case 'help': {
      // Holds something out towards the chef, bobbing along.
      const c = (t % 2) / 2;
      const out = c < 0.5 ? Math.sin(c * 2 * Math.PI) : 0;
      l.rightX = -0.6 - out * 0.8;
      l.leftX = -0.6 - out * 0.8;
      l.rightZ = 0.1;
      l.leftZ = -0.1;
      l.headX = 0.1 - out * 0.15;
      l.bob = Math.abs(Math.sin(t * 4)) * 0.02;
      break;
    }
  }
  if (waving) {
    l.rightX = -0.2;
    l.rightZ = -2.6 + Math.sin(t * 12) * 0.35;
    l.headZ = 0.15;
  }
  return l;
}

type PropName = 'knife' | 'ladle' | 'spoon' | 'card' | 'plate' | 'mug' | 'bell';

const POSE_PROPS: Partial<Record<Motion, PropName>> = {
  chop: 'knife',
  stir: 'ladle',
  taste: 'spoon',
  read: 'card',
  plate: 'plate',
  sip: 'mug',
  bell: 'bell',
};

// Shared geometry for every cook.
const geo = {
  leg: new THREE.CylinderGeometry(0.075, 0.07, 0.4, 6),
  shoe: new THREE.SphereGeometry(0.09, 6, 4),
  torso: new THREE.CylinderGeometry(0.25, 0.31, 0.62, 8),
  apron: boxGeo(0.4, 0.44, 0.04),
  band: new THREE.CylinderGeometry(0.265, 0.265, 0.05, 8),
  button: new THREE.SphereGeometry(0.022, 5, 3),
  head: new THREE.IcosahedronGeometry(0.27, 1),
  eye: new THREE.SphereGeometry(0.034, 6, 4),
  blush: new THREE.CircleGeometry(0.045, 8),
  hatBand: new THREE.CylinderGeometry(0.22, 0.22, 0.14, 8),
  hatPuff: new THREE.IcosahedronGeometry(0.26, 1),
  cap: new THREE.SphereGeometry(0.26, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
  arm: new THREE.CylinderGeometry(0.065, 0.06, 0.4, 6),
  hand: new THREE.SphereGeometry(0.075, 6, 4),
  blade: boxGeo(0.02, 0.05, 0.24),
  handle: boxGeo(0.03, 0.03, 0.1),
  stick: new THREE.CylinderGeometry(0.012, 0.012, 0.36, 5),
  bowl: new THREE.SphereGeometry(0.05, 6, 3, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
  card: boxGeo(0.2, 0.26, 0.012),
  plate: new THREE.CylinderGeometry(0.2, 0.15, 0.03, 10),
  food: new THREE.IcosahedronGeometry(0.1, 0),
  mug: new THREE.CylinderGeometry(0.055, 0.05, 0.11, 8),
  coffee: new THREE.CircleGeometry(0.048, 8),
  bellBase: new THREE.CylinderGeometry(0.1, 0.11, 0.025, 8),
  bellDome: new THREE.SphereGeometry(0.085, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2),
};

/** One material for every baked body part: the palette colours live in the vertices. */
const bodyMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.85,
  metalness: 0,
});

type Piece = { geometry: THREE.BufferGeometry; color: number; matrix: THREE.Matrix4 };

function piece(
  geometry: THREE.BufferGeometry,
  color: number,
  [x, y, z]: readonly [number, number, number] = [0, 0, 0],
  [sx, sy, sz]: readonly [number, number, number] = [1, 1, 1],
  rotY = 0,
): Piece {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
    new THREE.Vector3(sx, sy, sz),
  );
  return { geometry, color, matrix };
}

const bakedCache = new Map<string, THREE.BufferGeometry>();

/** Merge pieces into one geometry with per-vertex colours. Built once, shared by every cook. */
function baked(key: string, pieces: () => Piece[]): THREE.BufferGeometry {
  let g = bakedCache.get(key);
  if (g) return g;
  const parts = pieces().map(({ geometry, color, matrix }) => {
    const p = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(p.attributes)) {
      if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
    }
    p.applyMatrix4(matrix);
    const c = new THREE.Color(color);
    const n = p.attributes.position!.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    p.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return p;
  });
  g = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  bakedCache.set(key, g);
  return g;
}

export class CookFigure {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly leftArm = new THREE.Group();
  private readonly rightLeg = new THREE.Group();
  private readonly leftLeg = new THREE.Group();
  private readonly props = new Map<PropName, THREE.Object3D>();
  private readonly apronMat: THREE.MeshStandardMaterial;
  private readonly bellDome: THREE.Object3D;
  private current: PropName | null = null;
  /** Limb angles shown now; they blend towards each frame's target so poses never snap. */
  private readonly limbs: Limbs = { ...REST };

  constructor(
    apron: THREE.ColorRepresentation,
    readonly commis = false,
  ) {
    this.apronMat = ownMat(palette.jacket);
    this.apronMat.color.set(apron);
    const variant = commis ? 'commis' : 'chef';

    // Each rigid part is one baked, vertex-coloured mesh (one draw call) instead of a mesh per
    // piece, so a figure costs 7 draw calls rather than ~23. Keeps 20 cooks cheap.
    // Legs pivot at the hip.
    const legGeo = baked('leg', () => [
      piece(geo.leg, palette.trousers, [0, -0.2, 0]),
      piece(geo.shoe, palette.trousers, [0, -0.38, 0.04], [1, 0.6, 1.3]),
    ]);
    for (const [leg, x] of [
      [this.rightLeg, -0.12],
      [this.leftLeg, 0.12],
    ] as const) {
      leg.position.set(x, 0.4, 0);
      leg.add(mesh(legGeo, bodyMat));
      this.root.add(leg);
    }

    const torsoGeo = baked('torso', () => [
      piece(geo.torso, palette.jacket, [0, 0.7, 0]),
      ...(
        [
          [-0.08, 0.93],
          [0.08, 0.93],
          [-0.08, 0.86],
          [0.08, 0.86],
        ] as const
      ).map(([x, y]) => piece(geo.button, palette.trousers, [x, y, 0.245])),
    ]);
    const apronGeo = baked('apron', () => [
      piece(geo.apron, palette.jacket, [0, 0.6, 0.27]),
      piece(geo.band, palette.jacket, [0, 0.8, 0]),
    ]);
    this.body.add(mesh(torsoGeo, bodyMat), mesh(apronGeo, this.apronMat));

    // Head with a face on the +z side.
    this.head.position.set(0, 1.25, 0);
    const headGeo = baked(`head-${variant}`, () => {
      const parts = [piece(geo.head, palette.skin)];
      for (const s of [-1, 1]) {
        parts.push(piece(geo.eye, palette.eye, [s * 0.09, 0.02, 0.235], [1, 1.3, 0.6]));
        parts.push(piece(geo.blush, palette.blush, [s * 0.16, -0.06, 0.225], [1, 1, 1], s * 0.55));
      }
      if (commis) {
        parts.push(piece(geo.cap, palette.hat, [0, 0.1, 0], [1.02, 0.7, 1.02]));
      } else {
        parts.push(piece(geo.hatBand, palette.hat, [0, 0.26, 0]));
        parts.push(piece(geo.hatPuff, palette.hat, [0, 0.46, 0], [1, 0.85, 1]));
      }
      return parts;
    });
    this.head.add(mesh(headGeo, bodyMat));
    this.body.add(this.head);

    // Arms pivot at the shoulder; the right hand holds most props.
    const armGeo = baked('arm', () => [
      piece(geo.arm, palette.jacket, [0, -0.2, 0]),
      piece(geo.hand, palette.skin, [0, -0.42, 0]),
    ]);
    for (const [arm, x] of [
      [this.rightArm, -0.33],
      [this.leftArm, 0.33],
    ] as const) {
      arm.position.set(x, 0.97, 0);
      arm.add(mesh(armGeo, bodyMat));
      this.body.add(arm);
    }
    this.root.add(this.body);

    this.buildProps();
    this.bellDome = this.props.get('bell')!.children[1]!;
  }

  private buildProps(): void {
    const steel = mat(palette.steel, { roughness: 0.35 });
    const wood = mat(palette.woodDark);
    const inHand = (o: THREE.Object3D) => {
      o.position.set(0, -0.46, 0);
      this.rightArm.add(o);
      return o;
    };

    const knife = new THREE.Group();
    knife.add(mesh(geo.handle, wood, 0, 0, 0), mesh(geo.blade, steel, 0, -0.01, 0.16));
    this.props.set('knife', inHand(knife));

    const ladle = new THREE.Group();
    const stick = mesh(geo.stick, steel, 0, -0.1, 0.05);
    stick.rotation.x = 0.4;
    ladle.add(stick, mesh(geo.bowl, steel, 0, -0.27, 0.12));
    this.props.set('ladle', inHand(ladle));

    const spoon = new THREE.Group();
    const s2 = mesh(geo.stick, wood, 0, 0, 0.1);
    s2.rotation.x = Math.PI / 2;
    s2.scale.set(1, 0.6, 1);
    spoon.add(s2, mesh(geo.bowl, wood, 0, 0, 0.22));
    this.props.set('spoon', inHand(spoon));

    const card = new THREE.Group();
    const paper = mesh(geo.card, mat(palette.ticket), 0, 0, 0.1);
    paper.rotation.x = -0.5;
    card.add(paper);
    this.props.set('card', inHand(card));

    const mug = new THREE.Group();
    mug.add(mesh(geo.mug, mat(palette.mug), 0, 0, 0.06));
    const coffee = mesh(geo.coffee, mat(palette.coffee), 0, 0.056, 0.06);
    coffee.rotation.x = -Math.PI / 2;
    mug.add(coffee);
    this.props.set('mug', inHand(mug));

    // Held in front with both hands.
    const plate = new THREE.Group();
    plate.position.set(0, 0.99, 0.42);
    plate.add(mesh(geo.plate, mat(palette.plate), 0, 0, 0));
    const food = mesh(geo.food, mat(palette.tomato), -0.04, 0.07, 0);
    const herb = mesh(geo.food, mat(palette.leaf), 0.07, 0.06, 0.03);
    herb.scale.setScalar(0.6);
    plate.add(food, herb);
    this.body.add(plate);
    this.props.set('plate', plate);

    // The bell sits on the pass in front of the cook, not in its hand.
    const bell = new THREE.Group();
    bell.position.set(-0.3, COUNTER_HEIGHT, 0.7);
    bell.add(mesh(geo.bellBase, mat(palette.darkSteel), 0, 0.012, 0));
    bell.add(mesh(geo.bellDome, mat(palette.brass, { roughness: 0.3 }), 0, 0.025, 0));
    this.root.add(bell);
    this.props.set('bell', bell);

    for (const p of this.props.values()) p.visible = false;
  }

  setApron(color: THREE.ColorRepresentation): void {
    this.apronMat.color.set(color);
  }

  /** Show the prop for `motion` (none while walking, except a plate being carried). */
  setProp(motion: Motion, carrying: Carry): void {
    let want: PropName | null = motion === 'walk' ? carrying : (POSE_PROPS[motion] ?? null);
    // Idle extras keep the mug in hand.
    if ((motion === 'stretch' || motion === 'gaze') && carrying === 'mug') want = 'mug';
    // The pass bell only makes sense at chef scale.
    if (want === 'bell' && this.commis) want = null;
    if (want === this.current) return;
    if (this.current) this.props.get(this.current)!.visible = false;
    if (want) this.props.get(want)!.visible = true;
    this.current = want;
  }

  /**
   * Pose the limbs for `motion` at time `t`, blending from the current pose over `dt` seconds.
   * `dt` of 0 or less snaps straight to the pose (reduced motion, first frame).
   */
  animate(motion: Motion, t: number, waving: boolean, dt = 0): void {
    const target = limbsFor(motion, t, waving);
    if (motion === 'walk' && this.current === 'plate') {
      // Carrying the plate out in front with both hands.
      target.rightX = target.leftX = -1.45;
      target.rightZ = 0.15;
      target.leftZ = -0.15;
    }
    const l = dt > 0 ? blendInto(this.limbs, target, smoothing(BLEND_RATE, dt)) : target;
    if (l !== this.limbs) Object.assign(this.limbs, l);
    this.rightArm.rotation.set(l.rightX, 0, l.rightZ);
    this.leftArm.rotation.set(l.leftX, 0, l.leftZ);
    this.rightLeg.rotation.x = l.legSwing;
    this.leftLeg.rotation.x = -l.legSwing;
    this.body.position.y = l.bob;
    this.head.rotation.set(l.headX, 0, l.headZ);
    if (this.current === 'bell') {
      const c = t % BELL_PERIOD;
      this.bellDome.position.y = 0.025 - (c < 0.5 ? Math.abs(Math.sin(c * 4 * Math.PI)) * 0.01 : 0);
    }
  }

  dispose(): void {
    this.apronMat.dispose();
    this.root.removeFromParent();
  }
}
