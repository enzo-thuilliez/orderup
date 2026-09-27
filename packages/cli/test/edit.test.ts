import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/diff.js';
import { addOurHooksText, detectFormatting, removeOurHooksText } from '../src/edit.js';
import { forwarderScript, HOOK_MARKER } from '../src/forwarder.js';
import { withOurHooks, withoutOurHooks, type HookOptions } from '../src/settings.js';

const opts: HookOptions = { port: 7717, node: '/usr/bin/node', async: true, execForm: true };

/** Same result as the object model, key order included. */
function expectModel(text: string, result: string, model: typeof withOurHooks | 'remove') {
  const settings = JSON.parse(text) as Record<string, unknown>;
  const expected = model === 'remove' ? withoutOurHooks(settings) : model(settings, opts);
  expect(JSON.stringify(JSON.parse(result))).toBe(JSON.stringify(expected));
}

/**
 * The diff's removed and added lines. JSON needs a comma after the key before an appended
 * one, so a user line that only gains a trailing comma counts as unchanged.
 */
function changes(before: string, after: string) {
  const lines = diffLines(before, after);
  const added = lines.filter((l) => l.op === '+').map((l) => l.text);
  const removed = lines.filter((l) => l.op === '-').map((l) => l.text);
  const commaOnly = new Set(removed.filter((line) => added.includes(`${line},`)));
  return {
    removed: removed.filter((line) => !commaOnly.has(line)),
    added: added.filter((line) => !commaOnly.has(line.replace(/,$/, ''))),
  };
}

const oldHook = { type: 'command', command: `node -e '${forwarderScript(7717)}'` };

const pretty = `{
  "includeCoAuthoredBy": false,
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ],
    "PreCompact": []
  },
  "enabledPlugins": {
    "ecc@ecc": true
  },
  "theme": "dark"
}
`;

describe('addOurHooksText / removeOurHooksText', () => {
  it('adds only lines of its own and keeps every key in place', () => {
    const result = addOurHooksText(pretty, opts);
    expectModel(pretty, result, withOurHooks);
    const { removed, added } = changes(pretty, result);
    expect(removed).toEqual([]);
    expect(added.join('\n')).not.toMatch(/say done|enabledPlugins|theme|includeCoAuthoredBy/);
    expect(Object.keys(JSON.parse(result))).toEqual([
      'includeCoAuthoredBy',
      'hooks',
      'enabledPlugins',
      'theme',
    ]);
  });

  it('uninstall gives back the original file, byte for byte', () => {
    const installed = addOurHooksText(pretty, opts);
    const result = removeOurHooksText(installed);
    expect(result).toBe(pretty);
    expectModel(installed, result, 'remove');
  });

  it('is idempotent', () => {
    const once = addOurHooksText(pretty, opts);
    expect(addOurHooksText(once, opts)).toBe(once);
  });

  it('updates old entries in place, keeping "hooks" where it was (the reported case)', () => {
    // "hooks" second, holding only OrderUp hooks in the old bare-`node` shell form.
    const hooks = { SessionStart: [{ hooks: [oldHook] }], Stop: [{ hooks: [oldHook] }] };
    const old = JSON.stringify({ includeCoAuthoredBy: false, hooks, theme: 'dark' }, null, 2);
    const result = addOurHooksText(old, opts);
    expectModel(old, result, withOurHooks);
    expect(Object.keys(JSON.parse(result))).toEqual(['includeCoAuthoredBy', 'hooks', 'theme']);
    const { removed, added } = changes(old, result);
    expect([...removed, ...added].join('\n')).not.toMatch(/includeCoAuthoredBy|theme/);
    expect(removed.some((line) => line.includes("node -e '"))).toBe(true);
  });

  it('adds "hooks" last when the file has none, and removes it again', () => {
    const plain = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
    const result = addOurHooksText(plain, opts);
    expectModel(plain, result, withOurHooks);
    const { removed, added } = changes(plain, result);
    expect(removed).toEqual([]);
    expect(added.join('\n')).not.toMatch(/model|theme/);
    expect(removeOurHooksText(result)).toBe(plain);
  });

  it('leaves one-line user arrays on one line', () => {
    const compact = `{
  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] },
  "theme": "dark"
}
`;
    const result = addOurHooksText(compact, opts);
    expectModel(compact, result, withOurHooks);
    expect(result).toContain('[{ "hooks": [{ "type": "command", "command": "say done" }] }');
    expect(removeOurHooksText(result)).toBe(compact);
  });

  it('keeps tabs and CRLF line endings', () => {
    const windows = pretty.replace(/ {2}/g, '\t').replace(/\n/g, '\r\n');
    expect(detectFormatting(windows)).toEqual({ insertSpaces: false, tabSize: 1, eol: '\r\n' });
    const result = addOurHooksText(windows, opts);
    expectModel(windows, result, withOurHooks);
    expect(result.replace(/\r\n/g, '')).not.toContain('\n');
    expect(result).not.toMatch(/^ +"/m);
    expect(removeOurHooksText(result)).toBe(windows);
  });

  it('takes our hook out of a user group without touching the rest of it', () => {
    const group = { matcher: '', hooks: [{ type: 'command', command: 'say done' }, oldHook] };
    const mixed = JSON.stringify({ hooks: { Stop: [group] } }, null, 2);
    const result = removeOurHooksText(mixed);
    expectModel(mixed, result, 'remove');
    expect(result).not.toContain(HOOK_MARKER);
    expect(JSON.parse(result).hooks.Stop[0].matcher).toBe('');
  });

  it('drops events it no longer hooks, and keeps empty user events', () => {
    const legacy = JSON.stringify(
      { hooks: { PreCompact: [], SubagentStop: [{ hooks: [oldHook] }] } },
      null,
      2,
    );
    const result = addOurHooksText(legacy, opts);
    expectModel(legacy, result, withOurHooks);
    expect(JSON.parse(result).hooks.SubagentStop).toBeUndefined();
    expect(JSON.parse(result).hooks.PreCompact).toEqual([]);
  });

  it('never changes a file without OrderUp hooks on uninstall', () => {
    expect(removeOurHooksText(pretty)).toBe(pretty);
  });
});
