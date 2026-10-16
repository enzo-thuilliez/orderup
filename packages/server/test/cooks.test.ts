import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { SessionView } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import {
  CrewCooks,
  openDatabase,
  Repository,
  SessionStore,
  startServer,
  type RunnerEvent,
} from '../src/index.js';
import { FAKE_CLAUDE, tempRepo, tmp, waitFor } from './helpers.js';

const RUN = 'run-1';
const SESSION = 'sess-chef';

function setup() {
  let now = 1000;
  const store = new SessionStore({ repoOf: () => 'from-git', now: () => now });
  const cooks = new CrewCooks(store, () => now);
  const send = (event: RunnerEvent) => {
    now += 10;
    cooks.onRunnerEvent(event);
  };
  const chef = () => store.get(SESSION);
  return { store, send, chef, tick: (ms: number) => store.tick((now += ms)) };
}

const tool = (
  name: string,
  extra: Partial<Extract<RunnerEvent, { type: 'run.tool' }>> = {},
): RunnerEvent => ({
  type: 'run.tool',
  runId: RUN,
  toolUseId: `toolu_${name}`,
  name,
  parentToolUseId: null,
  target: null,
  ...extra,
});

function start(send: (event: RunnerEvent) => void) {
  send({
    type: 'run.started',
    runId: RUN,
    trigger: 'assign',
    taskId: 't1',
    cwd: '/home/u/.orderup/worktrees/kitchen/t1',
    repo: 'kitchen',
  });
  send({ type: 'run.session', runId: RUN, sessionId: SESSION });
}

describe('CrewCooks', () => {
  it('shows the chef as a crew cook at the head-chef station', () => {
    const { send, chef } = setup();
    start(send);
    expect(chef()).toMatchObject({
      sessionId: SESSION,
      kind: 'crew',
      agent: null,
      station: 'head-chef',
      crewState: 'working',
      state: 'working',
      cwd: '/home/u/.orderup/worktrees/kitchen/t1',
      repo: 'kitchen',
    });
  });

  it('shows dispatched stations with their station, activity and end', () => {
    const { send, chef } = setup();
    start(send);
    send(tool('Agent', { toolUseId: 'toolu_hot', subagentType: 'orderup-hot', target: 'Add it' }));
    send(tool('Agent', { toolUseId: 'toolu_x', subagentType: 'Explore' }));
    expect(chef()!.activity).toMatchObject({ tool: 'Agent' });
    expect(chef()!.subagents).toEqual([
      expect.objectContaining({
        subagentId: 'toolu_hot',
        type: 'orderup-hot',
        station: 'hot',
        crewState: 'working',
      }),
      // A subagent that is not an OrderUp station: an unassigned commis.
      expect.objectContaining({ subagentId: 'toolu_x', station: null, crewState: 'working' }),
    ]);

    send(tool('Edit', { parentToolUseId: 'toolu_hot', target: 'src/a.ts' }));
    expect(chef()!.subagents[0]).toMatchObject({
      activity: { tool: 'Edit', target: 'src/a.ts' },
    });
    // The chef's own activity is untouched by a station's tool call.
    expect(chef()!.activity).toMatchObject({ tool: 'Agent' });

    send({
      type: 'run.subagent.ended',
      runId: RUN,
      toolUseId: 'toolu_hot',
      agentId: 'a1',
      status: 'completed',
    });
    send({
      type: 'run.subagent.ended',
      runId: RUN,
      toolUseId: 'toolu_x',
      agentId: null,
      status: 'failed',
    });
    expect(chef()!.subagents.map((a) => [a.station, a.state, a.crewState])).toEqual([
      ['hot', 'done', 'done'],
      [null, 'done', 'error'],
    ]);
  });

  it('takes tokens from run usage and ends with the run status', () => {
    const { send, chef, tick } = setup();
    start(send);
    send(tool('Agent', { toolUseId: 'toolu_hot', subagentType: 'orderup-hot' }));
    const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    send({ type: 'run.usage', runId: RUN, tokens, costUsd: 0.1 });
    expect(chef()!.tokens).toEqual(tokens);

    send({
      type: 'run.ended',
      runId: RUN,
      status: 'error',
      usage: { tokens, costUsd: 0.1 },
      resultText: null,
      exitCode: 1,
    });
    expect(chef()).toMatchObject({ state: 'done', crewState: 'error', subagents: [] });
    // The coffee break still comes, and the error is then over.
    tick(10 * 60_000);
    expect(chef()).toMatchObject({ state: 'idle', crewState: 'idle' });
  });

  it.each([
    ['success', 'done'],
    ['stopped', 'done'],
    ['usage_cap_reached', 'error'],
  ] as const)('ends a %s run as %s', (status, crewState) => {
    const { send, chef } = setup();
    start(send);
    send({
      type: 'run.ended',
      runId: RUN,
      status,
      usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 },
      resultText: null,
      exitCode: 0,
    });
    expect(chef()!.crewState).toBe(crewState);
  });

  it("drops hook and transcript events for the chef's session once claimed", () => {
    const { store, send, chef } = setup();
    // The user's hooks fire for the chef too, and may arrive first: an observed cook...
    store.apply({ sessionId: SESSION, at: 1, type: 'session.start', cwd: '/x' }, 'hook');
    expect(chef()).toMatchObject({ kind: 'observed' });
    // ...that the runner then claims.
    start(send);
    expect(chef()).toMatchObject({ kind: 'crew', station: 'head-chef' });

    store.apply({ sessionId: SESSION, at: 5000, type: 'stop' }, 'hook');
    store.apply({ sessionId: SESSION, at: 5000, type: 'waiting' }, 'transcript');
    store.apply(
      {
        sessionId: SESSION,
        at: 5000,
        type: 'tool.start',
        tool: 'Agent',
        target: null,
        subagent: { id: 'h', type: null },
      },
      'hook',
    );
    expect(chef()).toMatchObject({ state: 'working', crewState: 'working', subagents: [] });
  });

  it('ignores events of runs it never saw start', () => {
    const { store, send } = setup();
    send({ type: 'run.session', runId: 'other', sessionId: 's2' });
    send(tool('Edit', { runId: 'other' }));
    expect(store.snapshot()).toEqual([]);
  });
});

describe('crew cooks through the server (#19 acceptance)', () => {
  it('a task given to the chef shows the chef and its station as crew cooks', async () => {
    const { repo } = tempRepo();
    const dbPath = path.join(tmp('orderup-db-'), 'orderup.db');
    const logDir = tmp('orderup-fake-');
    const db = openDatabase(dbPath);
    new Repository(db).updateBrigadeConfig({ repoPath: repo });
    db.close();
    const runnerEvents: RunnerEvent[] = [];
    const server = await startServer({
      port: 0,
      projectsDir: false,
      crew: true,
      dbPath,
      runner: {
        claudeBin: FAKE_CLAUDE,
        env: { ...process.env, FAKE_CLAUDE_LOG: logDir },
        orderupDir: path.join(tmp('orderup-home-'), '.orderup'),
        onEvent: (event) => runnerEvents.push(event),
      },
    });
    const seen: SessionView[] = [];
    server.store.subscribe((change) => {
      if (change.type === 'upsert') seen.push(change.session);
    });
    try {
      const result = await server.runner!.startRun({
        trigger: 'assign',
        taskId: 't1',
        prompt: 'scenario:background',
      });
      expect(result).toMatchObject({ ok: true });
      await waitFor(() => runnerEvents.find((e) => e.type === 'run.ended'), 10_000);
      expect(readdirSync(logDir).length).toBeGreaterThan(0);

      const crew = seen.filter((s) => s.kind === 'crew');
      expect(crew.length).toBeGreaterThan(0);
      expect(crew.every((s) => s.station === 'head-chef')).toBe(true);
      expect(crew.some((s) => s.crewState === 'working')).toBe(true);
      const stations = crew.flatMap((s) => s.subagents);
      expect(stations).toContainEqual(
        expect.objectContaining({ station: 'hot', crewState: 'working' }),
      );
      expect(stations).toContainEqual(
        expect.objectContaining({ station: 'hot', crewState: 'done' }),
      );
      // The run is over: the chef is plated, done.
      expect(server.store.snapshot()).toEqual([
        expect.objectContaining({ kind: 'crew', state: 'done', crewState: 'done' }),
      ]);
    } finally {
      await server.close();
    }
  });
});
