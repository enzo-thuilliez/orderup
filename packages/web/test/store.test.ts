import { PROTOCOL_VERSION, type ServerMessage, type SessionView } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import { applyMessage, initialState, parseMessage, withStatus } from '../src/net/store';

const s = (sessionId: string, state: SessionView['state'] = 'working'): SessionView => ({
  sessionId,
  kind: 'observed',
  agent: null,
  cwd: '/x',
  repo: null,
  state,
  activity: null,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  subagents: [],
  startedAt: 0,
  updatedAt: 0,
});

const run = (...msgs: ServerMessage[]) => msgs.reduce(applyMessage, initialState('open'));

describe('applyMessage', () => {
  it('replaces everything on snapshot', () => {
    const st = run(
      { type: 'hello', protocol: PROTOCOL_VERSION, serverVersion: '0.1.0' },
      { type: 'snapshot', sessions: [s('a'), s('b')] },
      { type: 'snapshot', sessions: [s('c')] },
    );
    expect([...st.sessions.keys()]).toEqual(['c']);
    expect(st.serverVersion).toBe('0.1.0');
  });

  it('applies upserts and removes', () => {
    const st = run(
      { type: 'snapshot', sessions: [s('a')] },
      { type: 'session.upsert', session: s('a', 'done') },
      { type: 'session.upsert', session: s('b') },
      { type: 'session.remove', sessionId: 'a' },
    );
    expect([...st.sessions.keys()]).toEqual(['b']);
  });

  it('does not mutate the previous state', () => {
    const before = run({ type: 'snapshot', sessions: [s('a')] });
    const after = applyMessage(before, { type: 'session.upsert', session: s('b') });
    expect(before.sessions.size).toBe(1);
    expect(after.sessions.size).toBe(2);
    expect(applyMessage(after, { type: 'session.remove', sessionId: 'zz' })).toBe(after);
  });

  it('refuses a server speaking another protocol version', () => {
    const st = run(
      { type: 'hello', protocol: PROTOCOL_VERSION + 1, serverVersion: '9.0.0' },
      { type: 'snapshot', sessions: [s('a')] },
    );
    expect(st.status).toBe('incompatible');
    expect(st.serverProtocol).toBe(PROTOCOL_VERSION + 1);
    expect(st.sessions.size).toBe(0);
    expect(withStatus(st, 'connecting').status).toBe('incompatible');
  });

  it('ignores command results', () => {
    const st = run({ type: 'snapshot', sessions: [s('a')] });
    expect(
      applyMessage(st, { type: 'command.result', id: '1', ok: false, error: 'not_implemented' }),
    ).toBe(st);
  });
});

describe('parseMessage', () => {
  it('accepts well-formed messages', () => {
    const msg = { type: 'snapshot', sessions: [s('a')] };
    expect(parseMessage(JSON.stringify(msg))).toEqual(msg);
    expect(parseMessage('{"type":"session.remove","sessionId":"a"}')).toEqual({
      type: 'session.remove',
      sessionId: 'a',
    });
  });

  it('rejects junk', () => {
    expect(parseMessage('not json')).toBeNull();
    expect(parseMessage(42)).toBeNull();
    expect(parseMessage('null')).toBeNull();
    expect(parseMessage('{"type":"nope"}')).toBeNull();
    expect(parseMessage('{"type":"session.upsert","session":{"sessionId":"a"}}')).toBeNull();
    expect(parseMessage('{"type":"snapshot","sessions":"x"}')).toBeNull();
    expect(parseMessage('{"type":"hello"}')).toBeNull();
  });
});
