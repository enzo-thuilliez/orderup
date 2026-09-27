import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '../src/sessions/machine.js';
import { TranscriptParser, TranscriptTail } from '../src/sources/transcripts.js';
import { waitFor } from './helpers.js';

const T = '2026-09-25T10:00:00.000Z';
const line = (entry: Record<string, unknown>) =>
  JSON.stringify({ sessionId: 's1', cwd: '/code/app', timestamp: T, ...entry });

const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    message: {
      id,
      role: 'assistant',
      content,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 1,
      },
      ...extra,
    },
  });

describe('TranscriptParser', () => {
  it('turns a user prompt into a prompt event, without its text', () => {
    const events = new TranscriptParser().parse(
      line({ type: 'user', message: { role: 'user', content: 'secret recipe' } }),
      'file',
    );
    expect(events).toEqual([
      { sessionId: 's1', at: Date.parse(T), cwd: '/code/app', type: 'prompt' },
    ]);
  });

  it('ignores meta lines, local command echoes and unknown types', () => {
    const p = new TranscriptParser();
    expect(p.parse(line({ type: 'user', isMeta: true, message: { content: 'x' } }), 'f')).toEqual(
      [],
    );
    expect(
      p.parse(
        line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
        'f',
      ),
    ).toEqual([]);
    expect(p.parse(line({ type: 'summary', summary: 'x' }), 'f')).toEqual([]);
    expect(p.parse('not json', 'f')).toEqual([]);
  });

  it('dedupes usage by message id across split lines and sums messages', () => {
    const p = new TranscriptParser();
    p.parse(assistant('m1', [{ type: 'text', text: 'hi' }]), 'f');
    p.parse(assistant('m1', [{ type: 'tool_use', id: 'u1', name: 'Read', input: {} }]), 'f');
    const events = p.parse(assistant('m2', [{ type: 'text', text: 'ok' }]), 'f');
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      tokens: { input: 20, output: 10, cacheRead: 200, cacheWrite: 2 },
    });
  });

  it('maps tool_use, tool_result and end_turn, with commis for Task', () => {
    const p = new TranscriptParser();
    const start = p.parse(
      assistant('m1', [
        {
          type: 'tool_use',
          id: 'u1',
          name: 'Task',
          input: { subagent_type: 'Plan', description: 'Plan menu' },
        },
      ]),
      'f',
    );
    expect(start.filter((e) => e.type !== 'usage')).toMatchObject([
      {
        type: 'tool.start',
        tool: 'Task',
        target: 'Plan menu',
        subagent: { id: 'u1', type: 'Plan' },
      },
    ]);

    const end = p.parse(
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1' }] } }),
      'f',
    );
    expect(end).toMatchObject([{ type: 'tool.end', subagentId: 'u1' }]);

    const stop = p.parse(
      assistant('m2', [{ type: 'text', text: 'Order up!' }], { stop_reason: 'end_turn' }),
      'f',
    );
    expect(stop.map((e) => e.type)).toEqual(['usage', 'stop']);
  });

  it('counts sidechain tokens but ignores their state', () => {
    const events = new TranscriptParser().parse(
      JSON.stringify({
        ...JSON.parse(assistant('m1', [{ type: 'tool_use', id: 'u', name: 'Read', input: {} }])),
        isSidechain: true,
      }),
      'f',
    );
    expect(events.map((e) => e.type)).toEqual(['usage']);
  });

  it('falls back to the file name for the session id', () => {
    const [event] = new TranscriptParser().parse(
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      'from-file',
    );
    expect(event?.sessionId).toBe('from-file');
  });
});

describe('TranscriptTail', () => {
  let tail: TranscriptTail | undefined;
  afterEach(() => tail?.stop());

  function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orderup-projects-'));
    const project = path.join(dir, '-code-app');
    mkdirSync(project);
    const events: SessionEvent[] = [];
    tail = new TranscriptTail({ projectsDir: dir, onEvent: (e) => events.push(e) });
    return { dir, project, events };
  }

  it('reads recent transcripts at startup and skips old ones', async () => {
    const { project, events } = setup();
    writeFileSync(
      path.join(project, 'recent.jsonl'),
      line({ type: 'user', message: { content: 'hi' } }) + '\n',
    );
    const old = path.join(project, 'old.jsonl');
    writeFileSync(old, line({ type: 'user', sessionId: 'old', message: { content: 'hi' } }) + '\n');
    const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(old, twoHoursAgo, twoHoursAgo);

    await tail!.start();
    expect(events.map((e) => e.sessionId)).toEqual(['s1']);
  });

  it('follows appended lines, including a line split across writes', async () => {
    const { project, events } = setup();
    const file = path.join(project, 's1.jsonl');
    writeFileSync(file, '');
    await tail!.start();

    const full = line({ type: 'user', message: { content: 'hi' } }) + '\n';
    appendFileSync(file, full.slice(0, 20));
    appendFileSync(file, full.slice(20));
    await waitFor(() => events.length === 1 || undefined);
    expect(events[0]).toMatchObject({ sessionId: 's1', type: 'prompt' });
  });

  it('picks up transcripts created after startup', async () => {
    const { project, events } = setup();
    await tail!.start();
    writeFileSync(
      path.join(project, 'new.jsonl'),
      line({ type: 'user', sessionId: 'new', message: { content: 'hi' } }) + '\n',
    );
    await waitFor(() => events.find((e) => e.sessionId === 'new'));
  });

  it('waits for a projects directory that does not exist yet', async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'orderup-missing-')), 'projects');
    tail = new TranscriptTail({ projectsDir: dir, onEvent: () => undefined, retryMs: 10 });
    await expect(tail.start()).resolves.toBeUndefined();
  });
});
