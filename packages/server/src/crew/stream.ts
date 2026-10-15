import type { UsageTokens } from '../persistence/index.js';

/**
 * Typed events from the head chef's `claude -p --output-format stream-json` output (headless
 * docs). One line is one JSON message; a line can carry several content blocks, so it maps to
 * zero or more events. Anything unknown or malformed maps to none: the stream format belongs
 * to the user's CLI version, and a line OrderUp does not understand never ends a run.
 *
 * No event carries prompt text: an `Agent` call keeps its `subagent_type` and short
 * `description`, never its `prompt` input (ADR-016 point 7).
 */
export type StreamEvent =
  /** `system/init`: the chef's session id, first in the stream. */
  | { kind: 'init'; sessionId: string }
  /** Assistant text. `parentToolUseId` is null in the chef's own conversation. */
  | { kind: 'text'; text: string; parentToolUseId: string | null; partial: boolean }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      parentToolUseId: string | null;
      /** `Agent` (or the older `Task`) calls only: the subagent's name, e.g. `orderup-hot`. */
      subagentType?: string;
      /** `Agent` calls only: the short dispatch description. */
      description?: string;
    }
  | {
      kind: 'tool_result';
      toolUseId: string;
      parentToolUseId: string | null;
      /** The subagent's `agentId`, when the result of an `Agent` call reports one. */
      agentId?: string;
    }
  | {
      kind: 'result';
      sessionId: string | null;
      /** `success`, or an error subtype such as `error_max_turns`. */
      subtype: string;
      isError: boolean;
      /** The chef's final text, where the report block lives. */
      text: string;
      /** As reported: for a resumed session this is the conversation's whole total. */
      totalCostUsd: number;
      tokens: UsageTokens;
    };

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const optStr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const parentOf = (msg: Obj): string | null => optStr(msg.parent_tool_use_id) ?? null;

/** Tool names of the subagent dispatcher: `Agent`, called `Task` by older CLI versions. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

function contentBlocks(msg: Obj): Obj[] {
  const message = msg.message;
  if (!isObj(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isObj);
}

function assistantEvents(msg: Obj): StreamEvent[] {
  const parentToolUseId = parentOf(msg);
  const events: StreamEvent[] = [];
  for (const block of contentBlocks(msg)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ kind: 'text', text: block.text, parentToolUseId, partial: false });
    } else if (block.type === 'tool_use' && typeof block.id === 'string') {
      const name = optStr(block.name) ?? '';
      const event: Extract<StreamEvent, { kind: 'tool_use' }> = {
        kind: 'tool_use',
        id: block.id,
        name,
        parentToolUseId,
      };
      if (AGENT_TOOLS.has(name) && isObj(block.input)) {
        const subagentType = optStr(block.input.subagent_type);
        const description = optStr(block.input.description);
        if (subagentType !== undefined) event.subagentType = subagentType;
        if (description !== undefined) event.description = description;
      }
      events.push(event);
    }
  }
  return events;
}

function userEvents(msg: Obj): StreamEvent[] {
  const parentToolUseId = parentOf(msg);
  // The structured result of the tool call, as the Agent SDK reports it next to the message.
  const structured = isObj(msg.tool_use_result) ? msg.tool_use_result : undefined;
  const agentId = optStr(structured?.agentId);
  const events: StreamEvent[] = [];
  for (const block of contentBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    events.push({
      kind: 'tool_result',
      toolUseId: block.tool_use_id,
      parentToolUseId,
      ...(agentId !== undefined ? { agentId } : {}),
    });
  }
  return events;
}

function resultEvent(msg: Obj): StreamEvent {
  const usage = isObj(msg.usage) ? msg.usage : {};
  return {
    kind: 'result',
    sessionId: optStr(msg.session_id) ?? null,
    subtype: optStr(msg.subtype) ?? 'unknown',
    isError: msg.is_error === true,
    text: optStr(msg.result) ?? '',
    totalCostUsd: count(msg.total_cost_usd),
    tokens: {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    },
  };
}

/** Parses one stream-json line. Unknown or malformed lines give `[]`, never an exception. */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isObj(msg)) return [];
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' && typeof msg.session_id === 'string' && msg.session_id
        ? [{ kind: 'init', sessionId: msg.session_id }]
        : [];
    case 'assistant':
      return assistantEvents(msg);
    case 'user':
      return userEvents(msg);
    case 'stream_event': {
      // Only with --include-partial-messages, which the runner does not pass today.
      const delta = isObj(msg.event) && isObj(msg.event.delta) ? msg.event.delta : undefined;
      return delta?.type === 'text_delta' && typeof delta.text === 'string'
        ? [{ kind: 'text', text: delta.text, parentToolUseId: parentOf(msg), partial: true }]
        : [];
    }
    case 'result':
      return [resultEvent(msg)];
    default:
      return [];
  }
}
