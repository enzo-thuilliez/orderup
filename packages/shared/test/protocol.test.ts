import { describe, expect, it } from 'vitest';
import {
  CREW_COMMAND_TYPES,
  HEAD_CHEF,
  STATIONS,
  isStation,
  parseCrewCommand,
  type CrewCommand,
} from '../src/index.js';

const base = { requestId: 'r1', token: 'tok', to: HEAD_CHEF };

const valid: CrewCommand[] = [
  { ...base, type: 'talk', text: 'hello chef' },
  { ...base, type: 'assign', ticket: { repo: 'owner/name', number: 31 } },
  { ...base, type: 'stop' },
  { ...base, type: 'approve', cardId: 'c1' },
  { ...base, type: 'send-back', cardId: 'c1', comment: 'tests are missing' },
];

describe('stations', () => {
  it('are exactly the ADR-016 ids, in order', () => {
    expect(STATIONS).toEqual(['head-chef', 'hot', 'garde-manger', 'commis', 'pastry', 'dish']);
  });

  it('isStation accepts only those ids', () => {
    for (const s of STATIONS) expect(isStation(s)).toBe(true);
    expect(isStation('sous-chef')).toBe(false);
    expect(isStation('orderup-hot')).toBe(false);
    expect(isStation(undefined)).toBe(false);
  });
});

describe('parseCrewCommand', () => {
  it('covers every command type', () => {
    expect(valid.map((c) => c.type)).toEqual([...CREW_COMMAND_TYPES]);
  });

  it.each(valid)('accepts a valid $type', (command) => {
    expect(parseCrewCommand(structuredClone(command))).toEqual({ ok: true, command });
  });

  it.each(STATIONS.filter((s) => s !== HEAD_CHEF))(
    'rejects every command addressed to %s with chef_only',
    (station) => {
      for (const command of valid) {
        expect(parseCrewCommand({ ...command, to: station })).toEqual({
          ok: false,
          command: command.type,
          code: 'chef_only',
          message: expect.any(String),
        });
      }
    },
  );

  it('rejects a missing or unknown addressee', () => {
    const { to: _to, ...noTo } = valid[0]!;
    expect(parseCrewCommand(noTo)).toMatchObject({ ok: false, code: 'invalid_command' });
    expect(parseCrewCommand({ ...valid[0], to: 'sous-chef' })).toMatchObject({
      ok: false,
      code: 'invalid_command',
    });
  });

  it('rejects extra fields, such as a station or the old memberId', () => {
    for (const extra of [{ station: 'hot' }, { memberId: 'm1' }, { prompt: 'x' }]) {
      expect(parseCrewCommand({ ...valid[0], ...extra })).toMatchObject({
        ok: false,
        command: 'talk',
        code: 'invalid_command',
      });
    }
  });

  it.each([
    ['not an object', 'talk'],
    ['null', null],
    ['an array', []],
    ['an unknown type', { ...base, type: 'spawn' }],
    ['no requestId', { ...valid[2], requestId: '' }],
    ['no token', { ...valid[2], token: undefined }],
    ['empty text', { ...valid[0], text: '' }],
    ['a ticket without owner', { ...valid[1], ticket: { repo: 'name', number: 1 } }],
    ['a non-integer ticket number', { ...valid[1], ticket: { repo: 'o/n', number: 1.5 } }],
    ['a null ticket', { ...valid[1], ticket: null }],
    ['an approve without cardId', { ...base, type: 'approve' }],
    ['a send-back without comment', { ...valid[4], comment: '' }],
  ])('rejects %s as invalid_command', (_label, value) => {
    expect(parseCrewCommand(value)).toMatchObject({ ok: false, code: 'invalid_command' });
  });
});
