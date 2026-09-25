/** An order ticket on the rail: repo, state and running token count, drawn on a canvas. */
import type { SessionView } from 'orderup-shared';
import * as THREE from 'three';
import { displayName, formatTokens, totalTokens } from '../logic/cook';
import { css, palette } from '../palette';

const W = 180;
const H = 250;
const SCALE = 2;

const STATE_LABEL: Record<SessionView['state'], string> = {
  working: 'COOKING',
  waiting: 'NEEDS YOU',
  done: 'ORDER UP',
  idle: 'ON BREAK',
};

const geometry = new THREE.PlaneGeometry(0.3, 0.42);
const clipGeometry = new THREE.BoxGeometry(0.1, 0.05, 0.03);

export class Ticket {
  readonly object = new THREE.Group();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshStandardMaterial;
  private key = '';
  private readonly phase = Math.random() * 10;

  constructor() {
    this.canvas.width = W * SCALE;
    this.canvas.height = H * SCALE;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      side: THREE.DoubleSide,
      roughness: 1,
    });
    const paper = new THREE.Mesh(geometry, this.material);
    paper.position.y = -0.23;
    paper.castShadow = true;
    const clip = new THREE.Mesh(
      clipGeometry,
      new THREE.MeshStandardMaterial({ color: palette.steel, flatShading: true }),
    );
    this.object.add(paper, clip);
  }

  draw(session: SessionView): void {
    const name = displayName(session);
    const tokens = formatTokens(totalTokens(session.tokens));
    const role = session.agent ? `CREW · ${session.agent.role}` : 'OBSERVED';
    const key = `${name}|${session.state}|${tokens}|${role}`;
    if (key === this.key) return;
    this.key = key;

    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    g.fillStyle = css(palette.ticket);
    g.fillRect(0, 0, W, H);
    g.fillStyle = css(session.state === 'waiting' ? palette.tomato : palette.ticketAccent);
    g.fillRect(0, 0, W, 34);
    // Perforation dots under the header.
    g.fillStyle = css(palette.ticket);
    for (let x = 6; x < W; x += 12) g.fillRect(x, 34, 5, 3);

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = css(palette.ticket);
    g.font = 'bold 17px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(STATE_LABEL[session.state], W / 2, 18);

    g.fillStyle = css(palette.ticketInk);
    g.font = 'bold 20px system-ui, sans-serif';
    g.fillText(fit(g, name, W - 16), W / 2, 64);
    g.font = '13px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(role, W / 2, 90);

    g.strokeStyle = css(palette.ticketInk);
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(12, 112);
    g.lineTo(W - 12, 112);
    g.stroke();
    g.setLineDash([]);

    g.font = 'bold 44px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(tokens, W / 2, 160);
    g.font = '14px ui-monospace, Menlo, Consolas, monospace';
    g.fillText('tokens', W / 2, 195);
    const subs = session.subagents.length;
    if (subs) g.fillText(`+${subs} commis`, W / 2, 222);
    this.texture.needsUpdate = true;
  }

  update(t: number): void {
    this.object.rotation.x = Math.sin(t * 1.3 + this.phase) * 0.06;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.texture.dispose();
    this.material.dispose();
  }
}

function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}
