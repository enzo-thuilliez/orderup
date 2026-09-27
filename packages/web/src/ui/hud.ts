/** Heads-up text: connection status, empty kitchen, controls and the walk-mode prompt. */
import { PROTOCOL_VERSION } from 'orderup-shared';
import type { CameraMode } from '../controls/cameraRig';
import type { ConnectionStatus } from '../net/store';

export interface HudText {
  status: string;
  /** Big centred message, or null when the kitchen has cooks. */
  notice: string | null;
}

export function hudText(
  status: ConnectionStatus,
  cooks: number,
  extra: { serverProtocol?: number | null } = {},
): HudText {
  const count = `${cooks} cook${cooks === 1 ? '' : 's'}`;
  switch (status) {
    case 'demo':
      return { status: `Demo kitchen · ${count}`, notice: null };
    case 'incompatible':
      return {
        status: 'Protocol mismatch',
        notice: `The server speaks protocol v${extra.serverProtocol ?? '?'}, this kitchen v${PROTOCOL_VERSION}.\nUpdate OrderUp so both match.`,
      };
    case 'connecting':
    case 'closed':
      return {
        status: cooks ? `Reconnecting… · ${count}` : 'Connecting…',
        notice: cooks
          ? null
          : 'Waiting for the OrderUp server on this machine.\nStart it with `npx orderup-cli`, or add ?demo to the URL.',
      };
    case 'open':
      return {
        status: `Live · ${count}`,
        notice: cooks
          ? null
          : 'The kitchen is quiet.\nStart a Claude Code session and a cook will walk in.',
      };
  }
}

export class Hud {
  private readonly status: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly help: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly crosshair: HTMLElement;

  constructor(parent: HTMLElement) {
    this.status = add(parent, 'hud-status');
    this.notice = add(parent, 'hud-notice');
    this.help = add(parent, 'hud-help');
    this.prompt = add(parent, 'hud-prompt');
    this.crosshair = add(parent, 'hud-crosshair');
    this.notice.hidden = true;
    this.prompt.hidden = true;
    this.crosshair.hidden = true;
  }

  setText({ status, notice }: HudText): void {
    setIfChanged(this.status, status);
    this.notice.hidden = !notice;
    if (notice) setIfChanged(this.notice, notice);
  }

  setMode(mode: CameraMode, locked: boolean): void {
    this.crosshair.hidden = mode !== 'walk';
    setIfChanged(
      this.help,
      mode === 'orbit'
        ? 'Drag to orbit · scroll to zoom · click a cook for details · Tab to walk'
        : locked
          ? 'WASD walk · Shift run · mouse look · E wave · F cook panel · Tab overview'
          : 'Click to look around · WASD / arrows walk · E wave · F cook panel · Tab overview',
    );
  }

  /** "E wave · F open" prompt for the cook in front of the walker, or hide it. */
  setPrompt(name: string | null): void {
    this.prompt.hidden = !name;
    if (name) setIfChanged(this.prompt, `E wave at ${name} · F open panel`);
  }
}

function add(parent: HTMLElement, className: string): HTMLElement {
  const e = document.createElement('div');
  e.className = className;
  parent.append(e);
  return e;
}

function setIfChanged(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}
