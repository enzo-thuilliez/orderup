/**
 * The kitchen itself: floor, walls, stations, the pass with its bell, the ticket rail, the back
 * door and the patio. All procedural, colours from the palette.
 */
import * as THREE from 'three';
import {
  BACK_COUNTER,
  BELL,
  COFFEE_TABLE,
  COFFEE_TABLE_RADIUS,
  DOOR,
  ISLAND,
  ISLAND_XS,
  PASS,
  PATIO,
  ROOM,
  WALL_HEIGHT,
} from '../logic/layout';
import { palette } from '../palette';
import { box, mat, mesh, ownMat } from './materials';

export const COUNTER_HEIGHT = 0.95;
/** Height of the rail the tickets hang from, above the pass. */
export const RAIL_Y = 2.45;
export const RAIL_Z = PASS.z + 0.1;

export interface Kitchen {
  group: THREE.Group;
  /** Parent for the tickets, positioned at the rail. */
  rail: THREE.Group;
  /** Fade the walls between the camera and the room (orbit view). */
  fadeWalls(camera: THREE.Vector3, enabled: boolean): void;
  /** Animate the bell and the stoves. */
  update(t: number, ringing: boolean): void;
}

interface Wall {
  material: THREE.MeshStandardMaterial;
  /** The camera is "outside" this wall when this returns true. */
  outside(p: THREE.Vector3): boolean;
}

export function buildKitchen(): Kitchen {
  const group = new THREE.Group();
  group.name = 'kitchen';

  buildGround(group);
  buildFloor(group);
  const walls = buildWalls(group);
  const flames = buildStations(group);
  const { bell, rail } = buildPass(group);
  buildPatio(group);
  buildLights(group);

  let lastFade: boolean[] = [];
  return {
    group,
    rail,
    fadeWalls(camera, enabled) {
      const fade = walls.map((w) => enabled && w.outside(camera));
      if (fade.every((f, i) => f === lastFade[i])) return;
      lastFade = fade;
      walls.forEach((w, i) => {
        w.material.transparent = fade[i]!;
        w.material.opacity = fade[i] ? 0.14 : 1;
        w.material.depthWrite = !fade[i];
        w.material.needsUpdate = true;
      });
    },
    update(t, ringing) {
      // A quick double wobble every 1.2 s while someone waits at the pass.
      const phase = t % 1.2;
      const hit = ringing && phase < 0.35;
      bell.rotation.z = hit ? Math.sin(phase * 40) * 0.18 * (1 - phase / 0.35) : 0;
      bell.position.y = COUNTER_HEIGHT + (hit ? 0.01 : 0);
      for (const [i, f] of flames.entries()) {
        const s = 0.85 + 0.15 * Math.sin(t * 9 + i * 1.7) + 0.08 * Math.sin(t * 23 + i);
        f.scale.set(1, s, 1);
      }
    },
  };
}

function buildGround(group: THREE.Group): void {
  const grass = new THREE.Mesh(new THREE.CircleGeometry(40, 24), mat(palette.grass));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = -0.21;
  grass.receiveShadow = true;
  group.add(grass);
}

function buildFloor(group: THREE.Group): void {
  // Checkerboard tiles, one instanced mesh.
  const w = ROOM.maxX - ROOM.minX;
  const d = ROOM.maxZ - ROOM.minZ;
  const tiles = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.96, 0.2, 0.96),
    new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }),
    w * d,
  );
  const m = new THREE.Matrix4();
  const a = new THREE.Color(palette.floorTile);
  const b = new THREE.Color(palette.floorGrout);
  let i = 0;
  for (let x = 0; x < w; x++) {
    for (let z = 0; z < d; z++) {
      m.makeTranslation(ROOM.minX + x + 0.5, -0.1, ROOM.minZ + z + 0.5);
      tiles.setMatrixAt(i, m);
      tiles.setColorAt(i, (x + z) % 2 ? a : b);
      i++;
    }
  }
  tiles.receiveShadow = true;
  group.add(tiles);
  // Grout underneath shows through the gaps.
  group.add(box(w, 0.18, d, mat(palette.floorGrout), 0, -0.2, (ROOM.minZ + ROOM.maxZ) / 2));
}

function buildWalls(group: THREE.Group): Wall[] {
  const T = 0.2;
  const H = WALL_HEIGHT;
  const walls: Wall[] = [];
  const add = (meshes: THREE.Mesh[], outside: Wall['outside']) => {
    const material = ownMat(palette.wall);
    for (const m of meshes) {
      m.material = material;
      group.add(m);
    }
    walls.push({ material, outside });
  };
  const w = ROOM.maxX - ROOM.minX + T * 2;
  const d = ROOM.maxZ - ROOM.minZ;
  const midZ = (ROOM.minZ + ROOM.maxZ) / 2;

  // Back wall, with a tiled splash band and two warm windows.
  const back = box(w, H, T, mat(palette.wall), 0, 0, ROOM.minZ - T / 2);
  add([back], (p) => p.z < ROOM.minZ);
  const splash = box(
    w - 0.4,
    0.7,
    0.04,
    mat(palette.tileSplash),
    0,
    COUNTER_HEIGHT,
    ROOM.minZ + 0.03,
  );
  group.add(splash);
  const hood = box(15.4, 0.35, 0.8, mat(palette.steel), 0, 2.2, ROOM.minZ + 0.4);
  group.add(hood);

  // Left wall with windows glowing from the night outside.
  const left = box(T, H, d, mat(palette.wall), ROOM.minX - T / 2, 0, midZ);
  add([left], (p) => p.x < ROOM.minX);
  for (const z of [-2.5, 2.5]) {
    group.add(box(0.06, 1.1, 1.5, mat(palette.wallTrim), ROOM.minX + 0.02, 1.2, z));
    group.add(
      box(
        0.05,
        0.95,
        1.35,
        mat(palette.sky, { emissive: palette.sky }),
        ROOM.minX + 0.05,
        1.275,
        z,
      ),
    );
  }
  // Shelf with copper pots on the left wall.
  group.add(box(0.35, 0.05, 3, mat(palette.woodDark), ROOM.minX + 0.18, 1.9, -4.3));
  for (let i = 0; i < 3; i++) {
    const pot = mesh(
      new THREE.CylinderGeometry(0.13, 0.11, 0.2, 8),
      mat(palette.copper, { roughness: 0.4 }),
      ROOM.minX + 0.2,
      2.05,
      -5.2 + i * 0.8,
    );
    group.add(pot);
  }

  // Right wall, split around the back door.
  const doorMin = DOOR.z - DOOR.width / 2;
  const doorMax = DOOR.z + DOOR.width / 2;
  const x = ROOM.maxX + T / 2;
  const r1 = box(T, H, doorMin - ROOM.minZ, mat(palette.wall), x, 0, (ROOM.minZ + doorMin) / 2);
  const r2 = box(T, H, ROOM.maxZ - doorMax, mat(palette.wall), x, 0, (doorMax + ROOM.maxZ) / 2);
  const lintel = box(T, H - DOOR.height, DOOR.width, mat(palette.wall), x, DOOR.height, DOOR.z);
  add([r1, r2, lintel], (p) => p.x > ROOM.maxX);
  // Door frame and the door itself, swung open onto the patio.
  for (const z of [doorMin, doorMax])
    group.add(box(0.26, DOOR.height, 0.08, mat(palette.wallTrim), x, 0, z));
  group.add(box(0.26, 0.08, DOOR.width + 0.08, mat(palette.wallTrim), x, DOOR.height, DOOR.z));
  const hinge = new THREE.Group();
  hinge.position.set(ROOM.maxX + T, 0, doorMax);
  hinge.rotation.y = -1.35;
  const slab = box(
    0.06,
    DOOR.height - 0.04,
    DOOR.width - 0.06,
    mat(palette.door),
    0,
    0,
    -(DOOR.width - 0.06) / 2,
  );
  const knob = mesh(
    new THREE.SphereGeometry(0.045, 6, 4),
    mat(palette.doorKnob),
    0.06,
    1.0,
    -DOOR.width + 0.2,
  );
  hinge.add(slab, knob);
  group.add(hinge);
  // A little "back door" lamp above it.
  group.add(
    mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      mat(palette.lampLight, { emissive: palette.lampLight }),
      x + 0.2,
      DOOR.height + 0.3,
      DOOR.z,
    ),
  );

  // Baseboards on every wall.
  group.add(box(w, 0.12, 0.05, mat(palette.wallTrim), 0, 0, ROOM.minZ + 0.02));
  group.add(box(0.05, 0.12, d, mat(palette.wallTrim), ROOM.minX + 0.02, 0, midZ));
  return walls;
}

/** Back counter with stoves, islands with cutting boards. Returns the flames to animate. */
function buildStations(group: THREE.Group): THREE.Object3D[] {
  const flames: THREE.Object3D[] = [];
  const H = COUNTER_HEIGHT;
  const bc = BACK_COUNTER;
  const bw = bc.maxX - bc.minX;
  group.add(box(bw, H - 0.06, bc.depth, mat(palette.counter), (bc.minX + bc.maxX) / 2, 0, bc.z));
  group.add(
    box(
      bw + 0.05,
      0.06,
      bc.depth + 0.05,
      mat(palette.counterTop),
      (bc.minX + bc.maxX) / 2,
      H - 0.06,
      bc.z,
    ),
  );

  const shadeMat = ownMat(palette.lampShade);
  shadeMat.side = THREE.DoubleSide;
  const flameGeo = new THREE.ConeGeometry(0.07, 0.14, 5);
  const flameMat = mat(palette.flame, { emissive: palette.flame });
  for (const x of ISLAND_XS) {
    // Stove on the back counter.
    group.add(box(1.0, 0.06, 0.7, mat(palette.darkSteel), x, H, bc.z));
    for (const dx of [-0.25, 0.25]) {
      const f = mesh(flameGeo, flameMat, x + dx, H + 0.1, bc.z + 0.05);
      f.castShadow = false;
      flames.push(f);
      group.add(f);
    }
    const pot = mesh(
      new THREE.CylinderGeometry(0.2, 0.17, 0.26, 8),
      mat(palette.copper, { roughness: 0.45 }),
      x - 0.25,
      H + 0.26,
      bc.z + 0.05,
    );
    const pan = mesh(
      new THREE.CylinderGeometry(0.2, 0.16, 0.06, 8),
      mat(palette.darkSteel),
      x + 0.25,
      H + 0.16,
      bc.z + 0.05,
    );
    const handle = box(0.3, 0.03, 0.04, mat(palette.darkSteel), x + 0.55, H + 0.15, bc.z + 0.05);
    group.add(pot, pan, handle);

    // Island: counter, top, cutting board and some veg.
    group.add(
      box(ISLAND.width - 0.1, H - 0.06, ISLAND.depth - 0.1, mat(palette.counter), x, 0, ISLAND.z),
    );
    group.add(
      box(ISLAND.width, 0.06, ISLAND.depth, mat(palette.counterTop), x, H - 0.06, ISLAND.z),
    );
    group.add(box(0.55, 0.04, 0.38, mat(palette.wood), x, H, ISLAND.z - 0.12));
    const tomato = mesh(
      new THREE.IcosahedronGeometry(0.07, 0),
      mat(palette.tomato),
      x + 0.45,
      H + 0.07,
      ISLAND.z - 0.05,
    );
    const carrot = mesh(
      new THREE.ConeGeometry(0.035, 0.24, 5),
      mat(palette.carrot),
      x - 0.5,
      H + 0.04,
      ISLAND.z + 0.05,
    );
    carrot.rotation.z = Math.PI / 2;
    const leaf = mesh(
      new THREE.IcosahedronGeometry(0.06, 0),
      mat(palette.leaf),
      x + 0.58,
      H + 0.06,
      ISLAND.z + 0.12,
    );
    group.add(tomato, carrot, leaf);

    // Pendant lamp over each island.
    group.add(box(0.015, 0.4, 0.015, mat(palette.lampShade), x, WALL_HEIGHT - 0.4, ISLAND.z));
    const shade = mesh(
      new THREE.ConeGeometry(0.28, 0.25, 8, 1, true),
      shadeMat,
      x,
      WALL_HEIGHT - 0.5,
      ISLAND.z,
    );
    const bulb = mesh(
      new THREE.SphereGeometry(0.08, 8, 6),
      mat(palette.lampLight, { emissive: palette.lampLight }),
      x,
      WALL_HEIGHT - 0.6,
      ISLAND.z,
    );
    bulb.castShadow = false;
    group.add(shade, bulb);
  }
  return flames;
}

function buildPass(group: THREE.Group): { bell: THREE.Group; rail: THREE.Group } {
  const H = COUNTER_HEIGHT;
  const w = PASS.maxX - PASS.minX;
  group.add(box(w - 0.1, H - 0.06, PASS.depth - 0.1, mat(palette.counter), 0, 0, PASS.z));
  group.add(box(w, 0.06, PASS.depth, mat(palette.steel, { roughness: 0.5 }), 0, H - 0.06, PASS.z));
  // Heat-lamp gantry with the ticket rail hanging off it.
  for (const x of [PASS.minX + 0.1, PASS.maxX - 0.1])
    group.add(box(0.08, RAIL_Y + 0.25 - H, 0.08, mat(palette.steel), x, H, PASS.z));
  group.add(box(w, 0.06, 0.45, mat(palette.steel), 0, RAIL_Y + 0.2, PASS.z));
  for (let x = PASS.minX + 0.9; x < PASS.maxX; x += 1.4) {
    const lamp = box(
      0.5,
      0.05,
      0.2,
      mat(palette.flame, { emissive: palette.flame }),
      x,
      RAIL_Y + 0.15,
      PASS.z,
    );
    lamp.castShadow = false;
    group.add(lamp);
  }
  const bar = mesh(
    new THREE.CylinderGeometry(0.02, 0.02, w, 6),
    mat(palette.darkSteel),
    0,
    RAIL_Y,
    RAIL_Z,
  );
  bar.rotation.z = Math.PI / 2;
  group.add(bar);
  const rail = new THREE.Group();
  rail.position.set(0, RAIL_Y, RAIL_Z + 0.03);
  group.add(rail);

  // The service bell.
  const bell = new THREE.Group();
  bell.position.set(BELL.x, H, BELL.z);
  const brass = mat(palette.brass, { roughness: 0.3 });
  bell.add(
    mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.03, 10), mat(palette.darkSteel), 0, 0.015, 0),
  );
  const dome = mesh(
    new THREE.SphereGeometry(0.12, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
    brass,
    0,
    0.03,
    0,
  );
  bell.add(dome, mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 6), brass, 0, 0.17, 0));
  bell.add(mesh(new THREE.SphereGeometry(0.025, 6, 4), brass, 0, 0.2, 0));
  group.add(bell);

  // A couple of plates waiting on the pass.
  for (const x of [-3.5, 2.8]) {
    group.add(
      mesh(
        new THREE.CylinderGeometry(0.2, 0.15, 0.03, 10),
        mat(palette.plate),
        x,
        H + 0.015,
        PASS.z,
      ),
    );
  }
  return { bell, rail };
}

function buildPatio(group: THREE.Group): void {
  const w = PATIO.maxX - PATIO.minX;
  const d = PATIO.maxZ - PATIO.minZ;
  const cx = (PATIO.minX + PATIO.maxX) / 2;
  const cz = (PATIO.minZ + PATIO.maxZ) / 2;
  // Decking planks.
  for (let i = 0; i < Math.floor(d / 0.5); i++) {
    const plank = box(
      w - 0.05,
      0.12,
      0.46,
      mat(i % 2 ? palette.wood : palette.patio),
      cx,
      -0.12,
      PATIO.minZ + 0.25 + i * 0.5,
    );
    plank.castShadow = false;
    group.add(plank);
  }
  // Low fence.
  const post = mat(palette.woodDark);
  for (let z = PATIO.minZ; z <= PATIO.maxZ + 0.01; z += 1)
    group.add(box(0.08, 0.8, 0.08, post, PATIO.maxX, 0, z));
  for (let x = PATIO.minX + 0.5; x <= PATIO.maxX; x += 1) {
    group.add(box(0.08, 0.8, 0.08, post, x, 0, PATIO.minZ));
    group.add(box(0.08, 0.8, 0.08, post, x, 0, PATIO.maxZ));
  }
  group.add(box(0.05, 0.06, d, post, PATIO.maxX, 0.7, cz));
  group.add(box(w, 0.06, 0.05, post, cx, 0.7, PATIO.minZ));
  group.add(box(w, 0.06, 0.05, post, cx, 0.7, PATIO.maxZ));

  // Coffee table with mugs, and a coffee machine on a crate.
  const top = mesh(
    new THREE.CylinderGeometry(COFFEE_TABLE_RADIUS, COFFEE_TABLE_RADIUS, 0.05, 10),
    mat(palette.wood),
    COFFEE_TABLE.x,
    0.95,
    COFFEE_TABLE.z,
  );
  const leg = mesh(
    new THREE.CylinderGeometry(0.05, 0.08, 0.93, 6),
    mat(palette.darkSteel),
    COFFEE_TABLE.x,
    0.46,
    COFFEE_TABLE.z,
  );
  group.add(top, leg);
  for (const [dx, dz] of [
    [0.15, 0.1],
    [-0.1, -0.18],
  ] as const) {
    group.add(
      mesh(
        new THREE.CylinderGeometry(0.05, 0.045, 0.1, 8),
        mat(palette.mug),
        COFFEE_TABLE.x + dx,
        1.02,
        COFFEE_TABLE.z + dz,
      ),
    );
  }
  group.add(box(0.6, 0.5, 0.5, mat(palette.woodDark), 12, 0, -5.5));
  group.add(box(0.4, 0.45, 0.35, mat(palette.darkSteel), 12, 0.5, -5.5));
  group.add(box(0.12, 0.05, 0.12, mat(palette.flame, { emissive: palette.flame }), 12, 0.8, -5.31));
  // A potted herb by the door.
  group.add(
    mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.35, 8), mat(palette.copper), 8.6, 0.175, -1.5),
  );
  group.add(mesh(new THREE.IcosahedronGeometry(0.3, 0), mat(palette.leaf), 8.6, 0.55, -1.5));

  // String lights over the patio.
  const bulbMat = mat(palette.lampLight, { emissive: palette.lampLight });
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const x = PATIO.minX + 0.2 + t * (w - 0.4);
    const sag = Math.sin(t * Math.PI) * 0.35;
    const b = mesh(new THREE.SphereGeometry(0.05, 6, 4), bulbMat, x, 2.4 - sag, cz);
    b.castShadow = false;
    group.add(b);
  }
}

function buildLights(group: THREE.Group): void {
  group.add(new THREE.HemisphereLight(palette.ambient, palette.night, 1.3));
  const sun = new THREE.DirectionalLight(palette.lampLight, 1.6);
  sun.position.set(-6, 12, 8);
  sun.target.position.set(1, 0, -1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -14;
  c.right = 14;
  c.top = 12;
  c.bottom = -12;
  c.near = 1;
  c.far = 40;
  sun.shadow.bias = -0.0005;
  group.add(sun, sun.target);
  for (const [x, y, z, i] of [
    [-3, 2.2, 0, 14],
    [3, 2.2, 0, 14],
    [0, 1.9, 3.8, 10],
    [10.5, 2.3, -3.5, 10],
  ] as const) {
    const p = new THREE.PointLight(palette.lampLight, i, 9, 1.6);
    p.position.set(x, y, z);
    group.add(p);
  }
}
