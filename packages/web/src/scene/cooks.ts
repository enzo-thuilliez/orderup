/**
 * Keeps one cook per session in the scene: stations, walking routes, poses, commis, speech
 * bubbles, steam and tickets. `sync` takes the latest sessions, `update` runs every frame.
 * What each cook plays comes from `logic/anim.ts`; this file only applies it.
 */
import type { SessionView, SubagentView } from 'orderup-shared';
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  commisMotion,
  commisPhase,
  commisScale,
  planFor,
  stepTrack,
  type Cue,
  type Track,
} from '../logic/anim';
import {
  assignSlots,
  besideChef,
  bubbleText,
  commisOffset,
  displayName,
  hashString,
  stepToward,
  subagentBubble,
  targetSpot,
  turnToward,
} from '../logic/cook';
import { OFFSTAGE, headingTo, passSpot, route, type Point, type Spot } from '../logic/layout';
import { palette } from '../palette';
import { CookFigure, type Motion } from './figure';
import { Steam } from './steam';
import { Ticket } from './ticket';

const WALK_SPEED = 2.3;
const COMMIS_SPEED = 3.2;
const TURN_SPEED = 9;
const COMMIS_SCALE = 0.68;
const WAVE_SECONDS = 2;

interface Label {
  object: CSS2DObject;
  alert: HTMLDivElement | null;
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
  /** Seconds since it popped in, and since it was told to leave (null while it stays). */
  age: number;
  leftFor: number | null;
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
  seed: number;
  track: Track | null;
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
  /** prefers-reduced-motion: cooks jump to their spot and hold still poses, no pops or steam. */
  private reduced = false;
  private readonly steam = new Steam();

  constructor(
    private readonly parent: THREE.Object3D,
    private readonly rail: THREE.Object3D,
  ) {
    parent.add(this.steam.mesh);
  }

  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    document.documentElement.classList.toggle('reduced-motion', reduced);
  }

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
    const reduced = this.reduced;
    this.steam.begin();
    for (const cook of [...this.cooks.values()]) {
      const walking = this.move(cook, dt);
      if (!walking && cook.leaving) {
        this.remove(cook);
        continue;
      }
      const s = cook.session;
      const waving = t < cook.waveUntil;
      const spot = this.spot(cook);
      const face = waving && cook.waveAt ? headingTo(cook.pos, cook.waveAt) : spot.facing;
      if (!walking) {
        cook.heading = reduced ? face : turnToward(cook.heading, face, TURN_SPEED * dt);
      }

      const { track, cues } = stepTrack(cook.track, s.state, walking, t);
      cook.track = track;
      const plan = planFor({
        state: s.state,
        activity: s.activity,
        walking,
        arrivedFor: track.arrivedAt === null ? null : t - track.arrivedAt,
        seed: cook.seed,
        t: t + cook.phase,
        reduced,
      });
      cook.figure.setProp(plan.motion, cook.leaving ? null : plan.carry);
      cook.figure.animate(plan.motion, reduced ? 0 : t + cook.phase, waving, reduced ? 0 : dt);
      cook.figure.root.position.set(cook.pos.x, plan.hop, cook.pos.z);
      cook.figure.root.rotation.y = cook.heading;
      if (plan.steam && !cook.leaving) this.steam.add(cook.pos, cook.heading, t, cook.seed);

      if (!cook.leaving) {
        const text = plan.bubble ? bubbleText(s.state, s.activity) : null;
        updateLabel(cook.label, text, s.state, displayName(s), s.kind, plan.alert);
        for (const cue of cues) playCue(cook.label, cue, reduced);
      }
      cook.ticket?.update(t);
      this.updateCommis(cook, dt, t);
    }
    this.steam.end();
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

  /** Cooks in the scene, including the ones on their way out (for the frame budget readout). */
  get figures(): number {
    let n = 0;
    for (const c of this.cooks.values()) n += 1 + c.commis.size;
    return n;
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
    const ticket = new Ticket(session.sessionId);
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
      seed: hashString(session.sessionId),
      track: null,
    };
    figure.root.position.set(cook.pos.x, 0, cook.pos.z);
    return cook;
  }

  private leave(cook: Cook): void {
    cook.leaving = true;
    cook.ticket?.dispose();
    cook.ticket = null;
    cook.label.object.element.style.display = 'none';
    for (const c of cook.commis.values()) c.leftFor ??= 0;
    this.retarget(cook);
  }

  /** The session is back before its cook made it out: turn round instead of respawning. */
  private comeBack(cook: Cook): void {
    cook.leaving = false;
    cook.ticket = new Ticket(cook.id);
    this.rail.add(cook.ticket.object);
    cook.label.object.element.style.display = '';
    cook.targetKey = '';
    cook.track = null;
  }

  private remove(cook: Cook): void {
    for (const c of cook.commis.values()) disposeCommis(c);
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
    if (this.reduced && cook.path.length) {
      // No walking across the screen: be there.
      cook.pos = { ...cook.path[cook.path.length - 1]! };
      cook.path = [];
      return false;
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
        if (!cook.leaving) existing.leftFor = null;
        continue;
      }
      const figure = new CookFigure(apronColor(cook.session), true);
      figure.root.userData.cookId = cook.id;
      figure.root.scale.setScalar(0);
      const label = makeLabel(true);
      figure.root.add(label.object);
      this.parent.add(figure.root);
      // Pops in right where it will stand, beside the chef.
      const chef: Spot = { x: cook.pos.x, z: cook.pos.z, facing: cook.heading };
      const pos = besideChef(chef, commisOffset(cook.commis.size));
      cook.commis.set(id, {
        sub,
        figure,
        label,
        pos,
        heading: cook.heading,
        age: 0,
        leftFor: cook.leaving ? 0 : null,
        phase: hashString(id) % 7,
      });
    }
    for (const c of cook.commis.values()) if (!subs.has(c.sub.subagentId)) c.leftFor ??= 0;
  }

  private updateCommis(cook: Cook, dt: number, t: number): void {
    const reduced = this.reduced;
    let i = 0;
    for (const [id, c] of cook.commis) {
      c.age += dt;
      if (c.leftFor !== null) c.leftFor += dt;
      const phase = commisPhase(c.age, c.leftFor, reduced);
      if (phase === 'gone') {
        disposeCommis(c);
        cook.commis.delete(id);
        continue;
      }
      const chef: Spot = { x: cook.pos.x, z: cook.pos.z, facing: cook.heading };
      const target = besideChef(chef, commisOffset(i++));
      const d = Math.hypot(target.x - c.pos.x, target.z - c.pos.z);
      // A leaving commis stops to wave goodbye at its chef, then shrinks away.
      const waving = phase === 'wave' || phase === 'shrink' || t < cook.waveUntil;
      const face =
        c.leftFor !== null
          ? headingTo(c.pos, cook.pos)
          : d > 0.05
            ? headingTo(c.pos, target)
            : cook.heading;
      const walking = c.leftFor === null && !reduced && d > 0.3;
      if (c.leftFor === null) {
        c.pos = reduced ? target : stepToward(c.pos, target, COMMIS_SPEED * dt);
      }
      c.heading = reduced ? face : turnToward(c.heading, face, TURN_SPEED * dt);

      const motion: Motion = commisMotion({
        subState: c.sub.state,
        subActivity: c.sub.activity,
        chefState: cook.session.state,
        walking,
        leaving: c.leftFor !== null,
      });
      c.figure.setProp(motion, null);
      c.figure.animate(motion, reduced ? 0 : t + c.phase, waving, reduced ? 0 : dt);
      c.figure.root.position.set(c.pos.x, 0, c.pos.z);
      c.figure.root.rotation.y = c.heading;
      c.figure.root.scale.setScalar(COMMIS_SCALE * commisScale(c.age, c.leftFor, reduced));
      const text = c.leftFor !== null ? null : subagentBubble(c.sub);
      updateLabel(c.label, text, c.sub.state, null, 'observed', false);
    }
  }
}

function disposeCommis(c: Commis): void {
  c.label.object.removeFromParent();
  c.label.object.element.remove();
  c.figure.dispose();
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
  let alert: HTMLDivElement | null = null;
  if (!commis) {
    alert = document.createElement('div');
    alert.className = 'alert';
    alert.textContent = '!';
    alert.hidden = true;
    el.append(alert);
  }
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
  return { object, alert, bubble, tag, key: '' };
}

function updateLabel(
  label: Label,
  text: string | null,
  state: string,
  name: string | null,
  kind: string,
  alert: boolean,
): void {
  const key = `${text}|${state}|${name}|${kind}|${alert}`;
  if (label.key === key) return;
  label.key = key;
  if (label.alert) label.alert.hidden = !alert;
  label.bubble.textContent = text ?? '';
  label.bubble.style.display = text ? '' : 'none';
  label.object.element.dataset.state = state;
  if (label.tag && name !== null) {
    label.tag.textContent = name;
    label.tag.dataset.kind = kind;
  }
}

/** Restart a CSS pop on the bubble ("Order up!") or the "!" (first ring). */
function playCue(label: Label, cue: Cue, reduced: boolean): void {
  if (reduced) return;
  const el = cue === 'orderUp' ? label.bubble : label.alert;
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth; // Reflow so the animation starts over.
  el.classList.add('pop');
}
