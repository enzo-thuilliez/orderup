import { describe, expect, it } from 'vitest';
import { forwarderHook, HOOK_MARKER } from '../src/forwarder.js';
import {
  formatSettings,
  HOOK_EVENTS,
  hookStatus,
  SettingsError,
  withOurHooks,
  withoutOurHooks,
} from '../src/settings.js';

type Groups = Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;

const userHook = { type: 'command', command: 'say done' };
const userSettings = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    Stop: [{ hooks: [userHook] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'backup.sh' }] }],
  },
};

const NODE = '/usr/local/bin/node';
const opts = { port: 7717, async: true, node: NODE, execForm: true };
const ourEntry = (port = 7717) => ({
  type: 'command',
  ...forwarderHook({ port, node: NODE, execForm: true }),
});

const ourHookFor = (settings: Record<string, unknown>, event: string) =>
  (settings.hooks as Groups)[event]?.at(-1)?.hooks[0] ?? {};

describe('withOurHooks', () => {
  it('adds one tagged hook per event next to the user hooks', () => {
    const next = withOurHooks(userSettings, opts);
    const hooks = next.hooks as Groups;

    expect(next.model).toBe('opus');
    expect(next.permissions).toEqual(userSettings.permissions);
    expect(hooks.PreCompact).toEqual(userSettings.hooks.PreCompact);
    expect(hooks.Stop?.[0]).toEqual({ hooks: [userHook] });
    expect(hooks.PreToolUse?.[0]?.matcher).toBe('Bash');
    for (const event of HOOK_EVENTS) {
      const ours = ourHookFor(next, event);
      expect(ours.type).toBe('command');
      expect(ours.command).toBe(NODE);
      expect((ours.args as string[])[1]).toContain(HOOK_MARKER);
      expect(ours.timeout).toBeLessThanOrEqual(5);
    }
  });

  it('is idempotent', () => {
    const once = withOurHooks(userSettings, opts);
    expect(withOurHooks(once, opts)).toEqual(once);
  });

  it('replaces its own hooks when the port changes', () => {
    const next = withOurHooks(withOurHooks(userSettings, opts), { ...opts, port: 8123 });
    expect(hookStatus(next).ports).toEqual([8123]);
    expect((next.hooks as Groups).Stop).toHaveLength(2);
  });

  it('runs hooks in the background only when asked, and never SessionEnd', () => {
    const background = withOurHooks({}, opts);
    expect(ourHookFor(background, 'PreToolUse').async).toBe(true);
    expect(ourHookFor(background, 'SessionEnd').async).toBeUndefined();
    const sync = withOurHooks({}, { ...opts, async: false });
    expect(ourHookFor(sync, 'PreToolUse').async).toBeUndefined();
  });

  it('uses shell form with a quoted absolute node when exec form is unavailable', () => {
    const node = "/Users/Jo O'Brien/.nvm/versions/node/v22.13.0/bin/node";
    const hook = ourHookFor(withOurHooks({}, { ...opts, node, execForm: false }), 'Stop');
    expect(hook.args).toBeUndefined();
    expect(hook.command).toMatch(/^'\/Users\/Jo O'\\''Brien\/.* -e '\/\*orderup-hook/);
    expect(hookStatus(withOurHooks({}, { ...opts, node, execForm: false })).nodes).toEqual([node]);
  });

  it('updates the node path in place when reinstalled from another Node', () => {
    const before = withOurHooks(userSettings, opts);
    const after = withOurHooks(before, { ...opts, node: '/opt/node24/bin/node' });
    expect(hookStatus(after).nodes).toEqual(['/opt/node24/bin/node']);
    expect(withoutOurHooks(after)).toEqual(userSettings);
  });

  it('creates the hooks object when there is none', () => {
    expect(Object.keys(withOurHooks({}, opts).hooks as object)).toEqual([...HOOK_EVENTS]);
  });

  it('refuses malformed hooks rather than overwrite them', () => {
    expect(() => withOurHooks({ hooks: 'nope' }, opts)).toThrow(SettingsError);
    expect(() => withOurHooks({ hooks: { Stop: {} } }, opts)).toThrow(SettingsError);
  });
});

describe('withoutOurHooks', () => {
  it('removes exactly what install added', () => {
    expect(withoutOurHooks(withOurHooks(userSettings, opts))).toEqual(userSettings);
    expect(withoutOurHooks(withOurHooks({ model: 'opus' }, opts))).toEqual({ model: 'opus' });
  });

  it('keeps user hooks that share a group with ours', () => {
    const mixed = {
      hooks: {
        Stop: [{ hooks: [userHook, ourEntry()] }],
      },
    };
    expect(withoutOurHooks(mixed)).toEqual({ hooks: { Stop: [{ hooks: [userHook] }] } });
  });

  it('leaves settings without OrderUp hooks untouched, empty containers included', () => {
    const settings = { hooks: { Stop: [] } };
    expect(withoutOurHooks(settings)).toBe(settings);
    expect(withoutOurHooks(userSettings)).toBe(userSettings);
  });
});

describe('hookStatus', () => {
  it('reports missing, complete and partial installs', () => {
    expect(hookStatus(userSettings)).toMatchObject({
      installed: false,
      complete: false,
      ports: [],
    });
    const full = withOurHooks(userSettings, opts);
    expect(hookStatus(full)).toEqual({
      installed: true,
      complete: true,
      missing: [],
      ports: [7717],
      nodes: [NODE],
    });
    const hooks = { ...(full.hooks as Groups) };
    delete hooks.Notification;
    expect(hookStatus({ hooks })).toMatchObject({
      installed: true,
      complete: false,
      missing: ['Notification'],
    });
  });
});

describe('formatSettings', () => {
  it('keeps the original indentation', () => {
    expect(formatSettings({ a: 1 }, '{\n    "b": 2\n}\n')).toBe('{\n    "a": 1\n}\n');
    expect(formatSettings({ a: 1 }, '{\n\t"b": 2\n}\n')).toBe('{\n\t"a": 1\n}\n');
    expect(formatSettings({ a: 1 }, null)).toBe('{\n  "a": 1\n}\n');
  });
});
