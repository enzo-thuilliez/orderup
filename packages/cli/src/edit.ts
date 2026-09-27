import jsonc from 'jsonc-parser';
import type { FormattingOptions, JSONPath, Node } from 'jsonc-parser';
import { isForwarderHook } from './forwarder.js';
import { HOOK_EVENTS, ourHookEntry, type HookOptions } from './settings.js';

/*
 * Edits settings.json as text, so everything that isn't an OrderUp hook stays byte for byte:
 * key order, indentation, one-line arrays, line endings. Only our entries show in the diff.
 */

// jsonc-parser's ESM build doesn't load in Node (extensionless imports): use its CJS entry.
const { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } = jsonc;

/** The file's own indentation and line endings, for the lines we insert. */
export function detectFormatting(text: string): FormattingOptions {
  const indent = /^([ \t]+)"/m.exec(text)?.[1];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent?.length ?? 2, eol };
}

function tree(text: string): Node {
  const root = parseTree(text);
  if (root?.type !== 'object') throw new Error('settings.json does not contain an object');
  return root;
}

/**
 * One edit, laid out like its surroundings: inline when the nearest non-empty container is
 * written on one line (the user's choice), with the file's indentation otherwise.
 */
function edit(
  text: string,
  path: JSONPath,
  value: unknown,
  container: JSONPath,
  isArrayInsertion = false,
): string {
  const root = tree(text);
  let inline = false;
  for (let at = container.length; at >= 0; at--) {
    const node = findNodeAtLocation(root, container.slice(0, at));
    if (!node?.children?.length) continue;
    inline = !text.slice(node.offset, node.offset + node.length).includes('\n');
    break;
  }
  const formattingOptions = inline ? undefined : detectFormatting(text);
  return applyEdits(text, modify(text, path, value, { formattingOptions, isArrayInsertion }));
}

/**
 * Removes the value at `path` with its separator: from the end of the previous sibling, or up
 * to the next one. The exact inverse of an insertion. (jsonc-parser's own removal drops one
 * character too few in one-line arrays.)
 */
function remove(text: string, path: JSONPath): string {
  const value = findNodeAtLocation(tree(text), path);
  if (!value) return text;
  const item = value.parent?.type === 'property' ? value.parent : value;
  const container = item.parent!;
  const siblings = container.children ?? [];
  const index = siblings.indexOf(item);
  const prev = siblings[index - 1];
  const next = siblings[index + 1];
  const [start, end] = prev
    ? [prev.offset + prev.length, item.offset + item.length]
    : next
      ? [item.offset, next.offset]
      : [container.offset + 1, container.offset + container.length - 1];
  return text.slice(0, start) + text.slice(end);
}

function isOurs(node: Node): boolean {
  if (node.type !== 'object') return false;
  const hook = getNodeValue(node) as Record<string, unknown>;
  return hook.type === 'command' && isForwarderHook(hook);
}

interface Found {
  event: string;
  group: number;
  hook: number;
  /** The group holds only OrderUp hooks. */
  alone: boolean;
}

/** OrderUp hooks in the file, in document order. */
function findOurs(text: string, events?: readonly string[]): Found[] {
  const found: Found[] = [];
  const hooks = findNodeAtLocation(tree(text), ['hooks']);
  if (hooks?.type !== 'object') return found;
  for (const prop of hooks.children ?? []) {
    const [key, groups] = prop.children ?? [];
    const event = String(key?.value);
    if (groups?.type !== 'array' || (events && !events.includes(event))) continue;
    for (const [group, node] of (groups.children ?? []).entries()) {
      const list = node.type === 'object' ? findNodeAtLocation(node, ['hooks']) : undefined;
      const entries = list?.type === 'array' ? (list.children ?? []) : [];
      const alone = entries.length > 0 && entries.every(isOurs);
      entries.forEach((entry, hook) => {
        if (isOurs(entry)) found.push({ event, group, hook, alone });
      });
    }
  }
  return found;
}

/** Children of the array or object at `path`, or -1 if there's none. */
function size(text: string, path: JSONPath): number {
  const node = findNodeAtLocation(tree(text), path);
  return node?.type === 'array' || node?.type === 'object' ? (node.children?.length ?? 0) : -1;
}

/** Removes OrderUp's hooks (optionally only under `events`), dropping what that emptied. */
function strip(text: string, events?: readonly string[]): string {
  // Last first, so earlier paths stay valid.
  for (const { event, group, hook, alone } of findOurs(text, events).reverse()) {
    if (!alone) {
      text = remove(text, ['hooks', event, group, 'hooks', hook]);
      continue;
    }
    if (size(text, ['hooks', event, group]) < 0) continue; // group already gone
    text = remove(text, ['hooks', event, group]);
    if (size(text, ['hooks', event]) !== 0) continue;
    text = remove(text, ['hooks', event]);
    if (size(text, ['hooks']) === 0) text = remove(text, ['hooks']);
  }
  return text;
}

/** Removes exactly OrderUp's hooks, and only the containers that removal left empty. */
export function removeOurHooksText(text: string): string {
  return strip(text);
}

/**
 * Installs one OrderUp group per event. An event's existing OrderUp group is replaced where
 * it is; otherwise the group goes after the user's own. Keys keep their order; new keys go
 * last.
 */
export function addOurHooksText(text: string, options: HookOptions): string {
  const group = (event: string) => ({ hooks: [ourHookEntry(event, options)] });
  text = strip(
    text,
    Object.keys(JSON.parse(text).hooks ?? {}).filter((e) => !HOOK_EVENTS.includes(e as never)),
  );
  if (size(text, ['hooks']) < 0) {
    const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [group(event)]]));
    return edit(text, ['hooks'], hooks, []);
  }
  for (const event of HOOK_EVENTS) {
    const ours = findOurs(text, [event]);
    const [first] = ours;
    if (ours.length === 1 && first?.alone) {
      text = edit(text, ['hooks', event, first.group], group(event), ['hooks', event]);
      continue;
    }
    text = strip(text, [event]);
    const groups = size(text, ['hooks', event]);
    text =
      groups < 0
        ? edit(text, ['hooks', event], [group(event)], ['hooks'])
        : edit(text, ['hooks', event, groups], group(event), ['hooks', event], true);
  }
  return text;
}
