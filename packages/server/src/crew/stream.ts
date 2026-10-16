import type { UsageTokens } from '../persistence/index.js';
import { toolTarget } from '../sources/hooks.js';

/**
 * Typed events from the head chef's `claude -p --output-format stream-json` output (headless
 * docs). One line is one JSON message; a line can carry several content blocks, so it maps to
 * zero or more events. Anything unknown or malformed maps to none: the stream format belongs
 * to the user's CLI version, and a line OrderUp does not understand never ends a run.
 *
 * No event carries prompt text: an `Agent` call keeps its `subagent_type` and short
 * `description`, never its `prompt` input, and `system/task_started` keeps its ids, never its
 * `prompt` field (ADR-016 point 7). Shapes checked with `scripts/probe-claude-cli.mjs`
 * (Claude Code 2.1.301, DECISIONS.md ADR-016 Follow-ups).
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
      /** File path or command for the bubble, as hooks show it (`toolTarget`). */
      target: string | null;
    }
  | {
      kind: 'tool_result';
      toolUseId: string;
      parentToolUseId: string | null;
      /** The subagent's `agentId`, when the result of an `Agent` call reports one. */
      agentId?: string;
      /**
       * `Agent` results: `completed` for a station that ran in the foreground,
       * `async_launched` for one that keeps running in the background.
       */
      status?: string;
      /** `Agent` results of a worktree station that finished: its branch. */
      worktreeBranch?: string;
    }
  /** `system/task_started`: a station subagent started. `agentId` is its `task_id`. */
  | { kind: 'task_started'; agentId: string; toolUseId: string | null; subagentType: string | null }
  /** `system/task_notification`: a station finished (`completed`, or an error status). */
  | { kind: 'task_ended'; agentId: string; toolUseId: string | null; status: string }
  /**
   * `system/permission_denied`: a tool call was denied without a prompt, for example a
   * background station's (`asyncAgent`). These are not in `result.permission_denials`.
   */
  | {
      kind: 'permission_denied';
      toolName: string | null;
      toolUseId: string | null;
      parentToolUseId: string | null;
      /** `decision_reason_type`, e.g. `asyncAgent`. */
      reason: string | null;
    }
  /** `system/vcs_state_changed`, e.g. a station's commit (`change: 'commit'`) on its branch. */
  | { kind: 'vcs'; change: string; branch: string | null; cwd: string | null }
  | {
      kind: 'result';
      sessionId: string | null;
      /** `success`, or an error subtype such as `error_max_turns`. */
      subtype: string;
      isError: boolean;
      /** The chef's final text, where the report block lives. */
      text: string;
      /** `terminal_reason`, e.g. `budget_exhausted`, when the CLI reports one. */
      terminalReason: string | null;
      /**
       * As reported: cumulative for the process, stations included, and for a resumed
       * session the conversation's whole total.
       */
      totalCostUsd: number;
      /**
       * `modelUsage` summed over models: cumulative like `totalCostUsd`, stations included.
       * Null when the CLI does not report it.
       */
      processTokens: UsageTokens | null;
      /** `usage`: this turn only, and the chef only (probe case b). */
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

function assistantEvents(msg: Obj, cwd: string | null): StreamEvent[] {
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
        target: toolTarget(isObj(block.input) ? block.input : null, cwd),
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
  const status = agentId !== undefined ? optStr(structured?.status) : undefined;
  const worktreeBranch = agentId !== undefined ? optStr(structured?.worktreeBranch) : undefined;
  const events: StreamEvent[] = [];
  for (const block of contentBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    events.push({
      kind: 'tool_result',
      toolUseId: block.tool_use_id,
      parentToolUseId,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(worktreeBranch !== undefined ? { worktreeBranch } : {}),
    });
  }
  return events;
}

/** `modelUsage` (`{ [model]: { inputTokens, ... } }`) summed over models, or null. */
function modelUsageTokens(value: unknown): UsageTokens | null {
  if (!isObj(value)) return null;
  const sum: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let any = false;
  for (const model of Object.values(value)) {
    if (!isObj(model)) continue;
    any = true;
    sum.input += count(model.inputTokens);
    sum.output += count(model.outputTokens);
    sum.cacheRead += count(model.cacheReadInputTokens);
    sum.cacheWrite += count(model.cacheCreationInputTokens);
  }
  return any ? sum : null;
}

/**
 * The `system` lines the runner reads besides `init`. Every other subtype (hooks, progress,
 * thinking tokens) gives no event. Only ids, names and statuses are kept: `task_started`
 * has the dispatch `prompt` and `task_notification` the station's `summary`, never read.
 */
function systemEvents(msg: Obj): StreamEvent[] {
  switch (msg.subtype) {
    case 'init':
      return typeof msg.session_id === 'string' && msg.session_id
        ? [{ kind: 'init', sessionId: msg.session_id }]
        : [];
    case 'task_started': {
      const agentId = optStr(msg.task_id);
      if (!agentId) return [];
      return [
        {
          kind: 'task_started',
          agentId,
          toolUseId: optStr(msg.tool_use_id) ?? null,
          subagentType: optStr(msg.subagent_type) ?? null,
        },
      ];
    }
    case 'task_notification': {
      const agentId = optStr(msg.task_id);
      if (!agentId) return [];
      return [
        {
          kind: 'task_ended',
          agentId,
          toolUseId: optStr(msg.tool_use_id) ?? null,
          status: optStr(msg.status) ?? 'unknown',
        },
      ];
    }
    case 'permission_denied':
      return [
        {
          kind: 'permission_denied',
          toolName: optStr(msg.tool_name) ?? null,
          toolUseId: optStr(msg.tool_use_id) ?? null,
          parentToolUseId: parentOf(msg),
          reason: optStr(msg.decision_reason_type) ?? null,
        },
      ];
    case 'vcs_state_changed':
      return [
        {
          kind: 'vcs',
          change: optStr(msg.kind) ?? 'unknown',
          branch: optStr(msg.branch) ?? null,
          cwd: optStr(msg.cwd) ?? null,
        },
      ];
    default:
      return [];
  }
}

function resultEvent(msg: Obj): StreamEvent {
  const usage = isObj(msg.usage) ? msg.usage : {};
  return {
    kind: 'result',
    sessionId: optStr(msg.session_id) ?? null,
    subtype: optStr(msg.subtype) ?? 'unknown',
    isError: msg.is_error === true,
    text: optStr(msg.result) ?? '',
    terminalReason: optStr(msg.terminal_reason) ?? null,
    totalCostUsd: count(msg.total_cost_usd),
    processTokens: modelUsageTokens(msg.modelUsage),
    tokens: {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
    },
  };
}

/**
 * Parses one stream-json line. Unknown or malformed lines give `[]`, never an exception.
 * `cwd` is the chef's working directory: tool targets inside it are shown relative to it.
 */
export function parseStreamLine(line: string, cwd: string | null = null): StreamEvent[] {
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
      return systemEvents(msg);
    case 'assistant':
      return assistantEvents(msg, cwd);
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
