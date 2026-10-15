import { HEAD_CHEF, STATIONS } from 'orderup-shared';
import { describe, expect, it } from 'vitest';
import {
  agentFileHash,
  agentFileName,
  agentsJson,
  agentsObject,
  renderAgentFile,
  STATION_DEFINITIONS,
  stationOfAgent,
  stationsHash,
} from '../src/crew/stations.js';

const READ_ONLY = ['Read', 'Grep', 'Glob'];
const WRITING = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

describe('station definitions (ADR-016 point 2)', () => {
  it('cover every station but the head chef, in protocol order', () => {
    expect(STATION_DEFINITIONS.map((def) => def.id)).toEqual(
      STATIONS.filter((id) => id !== HEAD_CHEF),
    );
    for (const def of STATION_DEFINITIONS) expect(def.name).toBe(`orderup-${def.id}`);
  });

  it('give the ADR-016 tools, never Agent, and a worktree to writing stations only', () => {
    const byId = Object.fromEntries(STATION_DEFINITIONS.map((def) => [def.id, def]));
    expect(byId.commis!.tools).toEqual(READ_ONLY);
    expect(byId.commis!.isolation).toBeUndefined();
    for (const id of ['hot', 'garde-manger', 'pastry', 'dish']) {
      expect(byId[id]!.tools).toEqual(WRITING);
      expect(byId[id]!.isolation).toBe('worktree');
    }
    for (const def of STATION_DEFINITIONS) expect(def.tools).not.toContain('Agent');
  });

  it('tell writing stations to commit and name their branch, and pastry to edit tests only', () => {
    for (const def of STATION_DEFINITIONS.filter((d) => d.isolation)) {
      expect(def.prompt).toMatch(/commit/i);
      expect(def.prompt).toContain('Branch: <branch>');
    }
    const pastry = STATION_DEFINITIONS.find((def) => def.id === 'pastry')!;
    expect(pastry.prompt).toMatch(/tests and test fixtures only/);
    for (const def of STATION_DEFINITIONS) expect(def.prompt).toMatch(/Never push/);
  });

  it('maps subagent names back to stations', () => {
    expect(stationOfAgent('orderup-hot')).toBe('hot');
    expect(stationOfAgent('orderup-garde-manger')).toBe('garde-manger');
    expect(stationOfAgent('orderup-head-chef')).toBeNull();
    expect(stationOfAgent('Explore')).toBeNull();
  });
});

describe('agentsJson', () => {
  it('builds the --agents object keyed by subagent name', () => {
    const parsed = JSON.parse(agentsJson()) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed)).toEqual(STATION_DEFINITIONS.map((def) => def.name));
    expect(parsed['orderup-hot']).toEqual({
      description: STATION_DEFINITIONS[0]!.description,
      prompt: STATION_DEFINITIONS[0]!.prompt,
      tools: WRITING,
      isolation: 'worktree',
    });
    expect(parsed['orderup-commis']).not.toHaveProperty('isolation');
    expect(parsed).toEqual(agentsObject());
  });
});

describe('stationsHash', () => {
  it('is a stable sha256 that changes with any definition', () => {
    expect(stationsHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(stationsHash()).toBe(stationsHash());
    const edited = STATION_DEFINITIONS.map((def, i) =>
      i === 0 ? { ...def, prompt: `${def.prompt}!` } : def,
    );
    expect(stationsHash(edited)).not.toBe(stationsHash());
  });
});

describe('renderAgentFile', () => {
  it('writes frontmatter the sub-agents docs describe, then the prompt', () => {
    const hot = STATION_DEFINITIONS[0]!;
    const text = renderAgentFile(hot, 'a'.repeat(64));
    expect(agentFileName(hot)).toBe('orderup-hot.md');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('\nname: orderup-hot\n');
    expect(text).toContain(`\ndescription: ${JSON.stringify(hot.description)}\n`);
    expect(text).toContain('\ntools: Read, Grep, Glob, Edit, Write, Bash\n');
    expect(text).toContain('\nisolation: worktree\n---\n\n');
    expect(text.endsWith(`${hot.prompt.trimEnd()}\n`)).toBe(true);
    expect(agentFileHash(text)).toBe('a'.repeat(64));
    expect(renderAgentFile(STATION_DEFINITIONS[2]!)).not.toContain('isolation');
    expect(agentFileHash('no hash here')).toBeNull();
  });
});
