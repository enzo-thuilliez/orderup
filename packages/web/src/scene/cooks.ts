/**
 * Keeps one cook per session in the scene: stations, walking routes, poses, commis, speech
 * bubbles and tickets. `sync` takes the latest sessions, `update` runs every frame.
 */
import type { SessionView, SubagentView } from 'orderup-shared';
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  assignSlots,
  besideChef,
  bubbleText,
  commisOffset,
  displayName,
  hashString,
  poseFor,
  stepToward,
  subagentBubble,
  targetSpot,
  turnToward,
} from '../logic/cook';
import { OFFSTAGE, headingTo, passSpot, route, type Point, type Spot } from '../logic/layout';
import { palette } from '../palette';
import { CookFigure, type Motion } from './figure';
import { Ticket } from './ticket';

const WALK_SPEED = 2.3;
const COMMIS_SPEED = 3.2;
const TURN_SPEED = 9;
const COMMIS_SCALE = 0.68;
const WAVE_SECONDS = 2;

interface Label {
  object: CSS2DObject;
  bubble: HTMLDivElement;
  tag: HTMLDivElement | null;
  key: string;
}

interface Commis {
  sub: SubagentView;
  figure: CookFigure;
  label: Label;
  pos: Point;
  heading: number;
  scale: number;
  leaving: boolean;
  phase: number;
}

interface Cook {
  id: string;
  session: SessionView;
  slot: number;
  figure: CookFigure;
  label: Label;
  ticket: Ticket | null;
  pos: Point;
  heading: number;
  path: Point[];
  targetKey: string;
  leaving: boolean;
  waveUntil: number;
  waveAt: Point | null;
  commis: Map<string, Commis>;
  phase: number;
}

export interface CookInfo extends Point {
  id: string;
  session: SessionView;
}

export class Cooks {
  private readonly cooks = new Map<string, Cook>();
  private slots = new Map<string, number>();
  private time = 0;
  /** Cooks already in the kitchen when the page opens start at their spot instead of walking in. */
  private settled = false;

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly rail: THREE.Object3D,
  ) {}

  sync(sessions: ReadonlyMap<string, SessionView>): void {
    this.slots = assignSlots(this.slots, [...sessions.keys()]);

    for (const [id, session] of sessions) {
      let cook = this.cooks.get(id);
      if (!cook) {
        cook = this.spawn(session, this.slots.get(id)!, !this.settled);
        this.cooks.set(id, cook);
      } else if (cook.leaving) {
        this.comeBack(cook);
      }
      cook.session = session;
      cook.slot = this.slots.get(id)!;
      cook.ticket?.draw(session);
      cook.ticket?.object.position.setX(passSpot(cook.slot).x);
      this.syncCommis(cook);
      this.retarget(cook);
    }
    for (const cook of this.cooks.values()) {
      if (!sessions.has(cook.id) && !cook.leaving) this.leave(cook);
    }
    if (sessions.size) this.settled = true;
  }

  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    for (const cook of [...this.cooks.values()]) {
      const walking = this.move(cook, dt);
      if (!walking && cook.leaving) {
        this.remove(cook);
        continue;
      }
      const waving = t < cook.waveUntil;
      const spot = this.spot(cook);
      const face = waving && cook.waveAt ? headingTo(cook.pos, cook.waveAt) : spot.facing;
      if (!walking) cook.heading = turnToward(cook.heading, face, TURN_SPEED * dt);
      const motion: Motion = walking ? 'walk' : poseFor(cook.session.state, cook.session.activity);
      const carrying =
        cook.session.state === 'done' ? 'plate' : cook.session.state === 'idle' ? 'mug' : null;
      cook.figure.setProp(motion, cook.leaving ? null : carrying);
      cook.figure.animate(motion, t + cook.phase, waving);
      cook.figure.root.position.set(cook.pos.x, 0, cook.pos.z);
      cook.figure.root.rotation.y = cook.heading;
      cook.ticket?.update(t);
      this.updateCommis(cook, dt, t);
    }
  }

  /** Cooks you can walk up to (not the ones heading out). */
  *list(): Iterable<CookInfo> {
    for (const c of this.cooks.values()) {
      if (!c.leaving) yield { id: c.id, x: c.pos.x, z: c.pos.z, session: c.session };
    }
  }

  get count(): number {
    let n = 0;
    for (const c of this.cooks.values()) if (!c.leaving) n++;
    return n;
  }

  wave(id: string, from: Point): void {
    const cook = this.cooks.get(id);
    if (!cook) return;
    cook.waveUntil = this.time + WAVE_SECONDS;
    cook.waveAt = { ...from };
    for (const c of cook.commis.values()) c.phase = this.time;
  }

  /** Cook under a ray (for clicking in the overview), or null. */
  pick(raycaster: THREE.Raycaster): string | null {
    const roots = [...this.cooks.values()].filter((c) => !c.leaving).map((c) => c.figure.root);
    const hit = raycaster.intersectObjects(roots, true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.cookId) o = o.parent;
    return (o?.userData.cookId as string | undefined) ?? null;
  }

  /** Highlight the cook the walker is facing. */
  setFocus(id: string | null): void {
    for (const c of this.cooks.values()) {
      c.label.object.element.classList.toggle('focus', c.id === id);
    }
  }

  private spawn(session: SessionView, slot: number, inPlace: boolean): Cook {
    const start = inPlace ? targetSpot(session.state, slot) : { ...OFFSTAGE, facing: -Math.PI / 2 };
    const figure = new CookFigure(apronColor(session));
    figure.root.userData.cookId = session.sessionId;
    const label = makeLabel(false);
    figure.root.add(label.object);
    this.parent.add(figure.root);
    const ticket = new Ticket();
    this.rail.add(ticket.object);
    const cook: Cook = {
      id: session.sessionId,
      session,
      slot,
      figure,
      label,
      ticket,
      pos: { x: start.x, z: start.z },
      heading: start.facing,
      path: [],
      targetKey: '',
      leaving: false,
      waveUntil: 0,
      waveAt: null,
      commis: new Map(),
      phase: (hashString(session.sessionId) % 1000) / 100,
    };
    figure.root.position.set(cook.pos.x, 0, cook.pos.z);
    return cook;
  }

  private leave(cook: Cook): void {
    cook.leaving = true;
    cook.ticket?.dispose();
    cook.ticket = null;
    cook.label.object.element.style.display = 'none';
    for (const c of cook.commis.values()) c.leaving = true;
    this.retarget(cook);
  }

  /** The session is back before its cook made it out: turn round instead of respawning. */
  private comeBack(cook: Cook): void {
    cook.leaving = false;
    cook.ticket = new Ticket();
    this.rail.add(cook.ticket.object);
    cook.label.object.element.style.display = '';
    cook.targetKey = '';
  }

  private remove(cook: Cook): void {
    for (const c of cook.commis.values()) c.figure.dispose();
    cook.label.object.removeFromParent();
    cook.label.object.element.remove();
    cook.figure.dispose();
    this.cooks.delete(cook.id);
  }

  private spot(cook: Cook): Spot {
    return cook.leaving
      ? { ...OFFSTAGE, facing: Math.PI / 2 }
      : targetSpot(cook.session.state, cook.slot);
  }

  private retarget(cook: Cook): void {
    const spot = this.spot(cook);
    const key = `${spot.x},${spot.z}`;
    if (key === cook.targetKey) return;
    cook.targetKey = key;
    cook.path = route(cook.pos, spot);
  }

  /** Advance along the path. Returns true while the cook is still walking. */
  private move(cook: Cook, dt: number): boolean {
    if (!cook.leaving) {
      const s = cook.session;
      updateLabel(cook.label, bubbleText(s.state, s.activity), s.state, displayName(s), s.kind);
    }
    let budget = WALK_SPEED * dt;
    while (cook.path.length && budget > 0) {
      const next = cook.path[0]!;
      const d = Math.hypot(next.x - cook.pos.x, next.z - cook.pos.z);
      if (d > 1e-4) {
        const want = headingTo(cook.pos, next);
        cook.heading = turnToward(cook.heading, want, TURN_SPEED * dt);
      }
      cook.pos = stepToward(cook.pos, next, budget);
      budget -= d;
      if (budget >= 0) cook.path.shift();
    }
    return cook.path.length > 0;
  }

  private syncCommis(cook: Cook): void {
    const subs = new Map(cook.session.subagents.map((s) => [s.subagentId, s]));
    for (const [id, sub] of subs) {
      const existing = cook.commis.get(id);
      if (existing) {
        existing.sub = sub;
        existing.leaving = false;
        continue;
      }
      const figure = new CookFigure(apronColor(cook.session), true);
      figure.root.userData.cookId = cook.id;
      figure.root.scale.setScalar(0.01);
      const label = makeLabel(true);
      figure.root.add(label.object);
      this.parent.add(figure.root);
      cook.commis.set(id, {
        sub,
        figure,
        label,
        pos: { ...cook.pos },
        heading: cook.heading,
        scale: 0.01,
        leaving: false,
        phase: hashString(id) % 7,
      });
    }
    for (const [id, c] of cook.commis) if (!subs.has(id)) c.leaving = true;
  }

  private updateCommis(cook: Cook, dt: number, t: number): void {
    let i = 0;
    for (const [id, c] of cook.commis) {
      const chef: Spot = { x: cook.pos.x, z: cook.pos.z, facing: cook.heading };
      const target = besideChef(chef, commisOffset(i++));
      const d = Math.hypot(target.x - c.pos.x, target.z - c.pos.z);
      const walking = d > 0.05;
      if (walking) c.heading = turnToward(c.heading, headingTo(c.pos, target), TURN_SPEED * dt);
      else c.heading = turnToward(c.heading, cook.heading, TURN_SPEED * dt);
      c.pos = stepToward(c.pos, target, COMMIS_SPEED * dt);

      const want = c.leaving ? 0 : COMMIS_SCALE;
      c.scale += (want - c.scale) * Math.min(1, dt * 6);
      if (c.leaving && c.scale < 0.03) {
        c.label.object.element.remove();
        c.figure.dispose();
        cook.commis.delete(id);
        continue;
      }
      const motion: Motion = walking && d > 0.3 ? 'walk' : poseFor(c.sub.state, c.sub.activity);
      c.figure.setProp(motion, null);
      c.figure.animate(motion, t + c.phase, t < cook.waveUntil);
      c.figure.root.position.set(c.pos.x, 0, c.pos.z);
      c.figure.root.rotation.y = c.heading;
      c.figure.root.scale.setScalar(c.scale);
      updateLabel(c.label, c.leaving ? null : subagentBubble(c.sub), c.sub.state, null, 'observed');
    }
  }
}

function apronColor(session: SessionView): THREE.Color {
  if (session.agent) {
    const { s, l } = palette.crewApron;
    return new THREE.Color().setHSL((session.agent.persona.hue % 360) / 360, s, l);
  }
  const aprons = palette.aprons;
  return new THREE.Color(aprons[hashString(session.sessionId) % aprons.length]!);
}

function makeLabel(commis: boolean): Label {
  const el = document.createElement('div');
  el.className = commis ? 'cook-label commis' : 'cook-label';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  el.append(bubble);
  let tag: HTMLDivElement | null = null;
  if (!commis) {
    tag = document.createElement('div');
    tag.className = 'tag';
    el.append(tag);
  }
  const object = new CSS2DObject(el);
  object.position.set(0, commis ? 2.3 : 2.15, 0);
  object.center.set(0.5, 1);
  return { object, bubble, tag, key: '' };
}

function updateLabel(
  label: Label,
  text: string | null,
  state: string,
  name: string | null,
  kind: string,
): void {
  const key = `${text}|${state}|${name}|${kind}`;
  if (label.key === key) return;
  label.key = key;
  label.bubble.textContent = text ?? '';
  label.bubble.style.display = text ? '' : 'none';
  label.object.element.dataset.state = state;
  if (label.tag && name !== null) {
    label.tag.textContent = name;
    label.tag.dataset.kind = kind;
  }
}
