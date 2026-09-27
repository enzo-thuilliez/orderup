/**
 * The cook panel (F in walk mode, or click a cook in the overview): live activity for observed
 * cooks, a chat placeholder for crew cooks until V1.
 */
import type { SessionView } from 'orderup-shared';
import { displayName, formatTokens, shortTarget, totalTokens } from '../logic/cook';

const STATE_TEXT: Record<SessionView['state'], string> = {
  working: 'Cooking at the station',
  waiting: 'Ringing the bell: needs you',
  done: 'Order up! Turn finished',
  idle: 'On a coffee break',
};

export interface PanelModel {
  title: string;
  subtitle: string;
  kind: SessionView['kind'];
  state: SessionView['state'];
  stateText: string;
  activity: { tool: string; target: string | null; for: string } | null;
  tokens: { label: string; value: string }[];
  commis: { name: string; doing: string }[];
  cwd: string;
  uptime: string;
}

export function panelModel(s: SessionView, now: number): PanelModel {
  return {
    title: displayName(s),
    subtitle: s.agent ? `Crew · ${s.agent.role}` : s.repo ? `Observed · ${s.repo}` : 'Observed',
    kind: s.kind,
    state: s.state,
    stateText: STATE_TEXT[s.state],
    activity: s.activity
      ? {
          tool: s.activity.tool,
          target: s.activity.target,
          for: duration(now - s.activity.since),
        }
      : null,
    tokens: [
      { label: 'Total', value: formatTokens(totalTokens(s.tokens)) },
      { label: 'Input', value: formatTokens(s.tokens.input) },
      { label: 'Output', value: formatTokens(s.tokens.output) },
      { label: 'Cache read', value: formatTokens(s.tokens.cacheRead) },
      { label: 'Cache write', value: formatTokens(s.tokens.cacheWrite) },
    ],
    commis: s.subagents.map((sub) => ({
      name: sub.type ?? 'commis',
      doing: sub.activity
        ? `${sub.activity.tool}${sub.activity.target ? ` · ${shortTarget(sub.activity.target)}` : ''}`
        : sub.state,
    })),
    cwd: s.cwd,
    uptime: duration(now - s.startedAt),
  };
}

/** `42s`, `3m 05s`, `2h 10m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export class Panel {
  private readonly root: HTMLElement;
  private sessionId: string | null = null;
  private renderedKind: string | null = null;
  private body!: HTMLElement;
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('aside', 'panel');
    this.root.hidden = true;
    this.root.setAttribute('aria-live', 'polite');
    parent.append(this.root);
  }

  get openId(): string | null {
    return this.sessionId;
  }

  open(session: SessionView, now: number): void {
    this.sessionId = session.sessionId;
    this.renderedKind = null;
    this.root.hidden = false;
    this.render(session, now);
  }

  close(): void {
    if (!this.sessionId) return;
    this.sessionId = null;
    this.root.hidden = true;
    this.onClose();
  }

  /** Refresh with the latest session, or close if the cook left. */
  update(sessions: ReadonlyMap<string, SessionView>, now: number): void {
    if (!this.sessionId) return;
    const s = sessions.get(this.sessionId);
    if (!s) {
      this.close();
      return;
    }
    this.render(s, now);
  }

  private render(s: SessionView, now: number): void {
    const m = panelModel(s, now);
    // Rebuild the frame only when the kind changes, so the chat input keeps focus and text.
    if (this.renderedKind !== m.kind) {
      this.renderedKind = m.kind;
      this.root.replaceChildren();
      const head = el('header', 'panel-head');
      const titles = el('div');
      titles.append(el('h2', 'panel-title'), el('div', 'panel-sub'));
      const close = el('button', 'panel-close', '×');
      close.title = 'Close (F or Esc)';
      close.addEventListener('click', () => this.close());
      head.append(titles, close);
      this.body = el('div', 'panel-body');
      this.root.append(head, this.body);
      if (m.kind === 'crew') this.root.append(chatBox());
    }
    this.root.dataset.state = m.state;
    this.root.querySelector('.panel-title')!.textContent = m.title;
    this.root.querySelector('.panel-sub')!.textContent = m.subtitle;

    const rows: HTMLElement[] = [];
    rows.push(section('Now', [el('div', `state state-${m.state}`, m.stateText)]));
    if (m.activity) {
      const act = el('div', 'activity');
      act.append(el('span', 'tool', m.activity.tool));
      if (m.activity.target) act.append(el('code', 'target', m.activity.target));
      act.append(el('span', 'muted', `for ${m.activity.for}`));
      rows.push(section('Activity', [act]));
    }
    if (m.commis.length) {
      rows.push(
        section(
          `Commis (${m.commis.length})`,
          m.commis.map((c) => {
            const row = el('div', 'commis-row');
            row.append(el('span', 'tool', c.name), el('span', 'muted', c.doing));
            return row;
          }),
        ),
      );
    }
    const table = el('dl', 'tokens');
    for (const t of m.tokens) table.append(el('dt', '', t.label), el('dd', '', t.value));
    rows.push(section('Ticket', [table]));
    const where = el('div', 'muted small');
    where.append(el('code', '', m.cwd), document.createTextNode(` · up ${m.uptime}`));
    rows.push(where);
    if (m.kind === 'observed') {
      rows.push(el('p', 'muted small', 'Observed cook: read-only, OrderUp spends no tokens here.'));
    }
    this.body.replaceChildren(...rows);
  }
}

function chatBox(): HTMLElement {
  const chat = el('div', 'chat');
  const log = el('div', 'chat-log');
  log.append(
    el(
      'div',
      'chat-msg system',
      'Crew cooks take orders in V1. For now this chat is a preview: messages are not sent.',
    ),
  );
  const form = el('form', 'chat-form');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'Talk to the crew (coming in V1)';
  input.disabled = true;
  const send = el('button', '', 'Send') as HTMLButtonElement;
  send.disabled = true;
  form.append(input, send);
  form.addEventListener('submit', (e) => e.preventDefault());
  chat.append(log, form);
  return chat;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const s = el('section', 'panel-section');
  s.append(el('h3', '', title), ...children);
  return s;
}

function el(tag: string, className = '', text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
