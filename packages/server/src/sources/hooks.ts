import path from 'node:path';
import type { SessionEvent } from '../sessions/machine.js';

type Json = Record<string, unknown>;

/** Tools that spawn a subagent (a commis cook). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

const MAX_TARGET = 80;

/**
 * Turns a Claude Code hook payload into a session event, or null when OrderUp doesn't care.
 * Every field except `session_id` and `hook_event_name` is optional: payloads vary across
 * Claude Code versions. Prompt text is never read.
 */
export function normalizeHook(payload: unknown, now = Date.now()): SessionEvent | null {
  if (!isObject(payload)) return null;
  const sessionId = str(payload.session_id);
  const name = str(payload.hook_event_name);
  if (!sessionId || !name) return null;

  const cwd = str(payload.cwd);
  const base = { sessionId, at: now, ...(cwd ? { cwd } : {}) };

  switch (name) {
    case 'SessionStart':
      return { ...base, type: 'session.start' };
    case 'UserPromptSubmit':
      return { ...base, type: 'prompt' };
    case 'PreToolUse': {
      const tool = str(payload.tool_name) ?? 'tool';
      const input = obj(payload.tool_input);
      const subagent = SUBAGENT_TOOLS.has(tool)
        ? { id: str(payload.tool_use_id) ?? `${sessionId}:${now}`, type: str(input?.subagent_type) }
        : undefined;
      return {
        ...base,
        type: 'tool.start',
        tool,
        target: toolTarget(input, cwd),
        ...(subagent ? { subagent } : {}),
      };
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool = str(payload.tool_name);
      const toolUseId = str(payload.tool_use_id);
      const subagentId = tool && SUBAGENT_TOOLS.has(tool) && toolUseId ? toolUseId : undefined;
      return { ...base, type: 'tool.end', ...(subagentId ? { subagentId } : {}) };
    }
    case 'PermissionRequest':
      return { ...base, type: 'waiting' };
    case 'Notification':
      return isIdlePrompt(payload) ? null : { ...base, type: 'waiting' };
    case 'Stop':
      return { ...base, type: 'stop' };
    case 'SessionEnd':
      return { ...base, type: 'end' };
    default:
      return null;
  }
}

/** "Claude is waiting for your input" after a finished turn: the plate is already at the pass. */
function isIdlePrompt(payload: Json): boolean {
  if (payload.notification_type === 'idle_prompt') return true;
  return /waiting for your input/i.test(str(payload.message) ?? '');
}

/** What to show in the cook's bubble: a file (relative to cwd), a command, or a query. */
export function toolTarget(input: Json | null, cwd: string | null): string | null {
  if (!input) return null;
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (file) return truncate(relativeTo(file, cwd));
  const text =
    str(input.command) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.description);
  return text ? truncate(firstLine(text)) : null;
}

function relativeTo(file: string, cwd: string | null): string {
  if (!cwd || !path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}

function firstLine(text: string): string {
  return text.trimStart().split('\n', 1)[0] ?? '';
}

function truncate(text: string): string {
  return text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET - 1)}…` : text;
}

export function isSubagentTool(tool: string): boolean {
  return SUBAGENT_TOOLS.has(tool);
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function obj(value: unknown): Json | null {
  return isObject(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
