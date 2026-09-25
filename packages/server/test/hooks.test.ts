import { describe, expect, it } from 'vitest';
import { normalizeHook, toolTarget } from '../src/sources/hooks.js';

const base = { session_id: 's1', cwd: '/code/app', transcript_path: '/t.jsonl' };
const hook = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
  normalizeHook({ ...base, hook_event_name, ...extra }, 1000);

describe('normalizeHook', () => {
  it('maps session lifecycle events', () => {
    expect(hook('SessionStart', { source: 'startup' })).toEqual({
      sessionId: 's1',
      at: 1000,
      cwd: '/code/app',
      type: 'session.start',
    });
    expect(hook('Stop')?.type).toBe('stop');
    expect(hook('SessionEnd', { reason: 'exit' })?.type).toBe('end');
  });

  it('never carries prompt text', () => {
    const event = hook('UserPromptSubmit', { prompt: 'my secret plan' });
    expect(event).toEqual({ sessionId: 's1', at: 1000, cwd: '/code/app', type: 'prompt' });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('maps PreToolUse to a tool start with a cwd-relative file target', () => {
    expect(
      hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/code/app/src/a.ts' } }),
    ).toMatchObject({ type: 'tool.start', tool: 'Edit', target: 'src/a.ts' });
  });

  it('spawns a commis for Task/Agent and removes it on PostToolUse', () => {
    const start = hook('PreToolUse', {
      tool_name: 'Task',
      tool_use_id: 'toolu_1',
      tool_input: { subagent_type: 'Explore', description: 'Find the oven' },
    });
    expect(start).toMatchObject({
      type: 'tool.start',
      target: 'Find the oven',
      subagent: { id: 'toolu_1', type: 'Explore' },
    });
    expect(hook('PostToolUse', { tool_name: 'Task', tool_use_id: 'toolu_1' })).toMatchObject({
      type: 'tool.end',
      subagentId: 'toolu_1',
    });
    expect(hook('PostToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_2' })).not.toHaveProperty(
      'subagentId',
    );
  });

  it('rings the bell for permission requests and notifications, but not idle prompts', () => {
    expect(hook('PermissionRequest', { tool_name: 'Bash' })?.type).toBe('waiting');
    expect(
      hook('Notification', { message: 'Claude needs your permission to use Bash' })?.type,
    ).toBe('waiting');
    expect(hook('Notification', { notification_type: 'idle_prompt' })).toBeNull();
    expect(hook('Notification', { message: 'Claude is waiting for your input' })).toBeNull();
  });

  it('ignores unknown events and invalid payloads', () => {
    expect(hook('PreCompact')).toBeNull();
    expect(normalizeHook(null)).toBeNull();
    expect(normalizeHook([])).toBeNull();
    expect(normalizeHook({ hook_event_name: 'Stop' })).toBeNull();
    expect(normalizeHook({ session_id: 's1' })).toBeNull();
  });

  it('tolerates a missing cwd', () => {
    expect(normalizeHook({ session_id: 's1', hook_event_name: 'Stop' }, 1)).toEqual({
      sessionId: 's1',
      at: 1,
      type: 'stop',
    });
  });
});

describe('toolTarget', () => {
  it('keeps paths outside cwd absolute', () => {
    expect(toolTarget({ file_path: '/etc/hosts' }, '/code/app')).toBe('/etc/hosts');
  });

  it('shows the first line of a command, truncated', () => {
    expect(toolTarget({ command: '  npm test\n&& echo done' }, null)).toBe('npm test');
    const long = toolTarget({ command: 'x'.repeat(200) }, null);
    expect(long).toHaveLength(80);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('falls back to pattern, url, query, description', () => {
    expect(toolTarget({ pattern: 'TODO' }, null)).toBe('TODO');
    expect(toolTarget({ url: 'https://example.com' }, null)).toBe('https://example.com');
    expect(toolTarget({}, null)).toBeNull();
    expect(toolTarget(null, null)).toBeNull();
  });
});
