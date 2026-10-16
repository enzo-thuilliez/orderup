import { watch, type FSWatcher } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TokenUsage } from 'orderup-shared';
import type { SessionEvent } from '../sessions/machine.js';
import { isObject, isSubagentTool, obj, str, toolTarget } from './hooks.js';

type Json = Record<string, unknown>;

interface SessionUsage {
  /** Latest usage per assistant message id: one message is split over several lines. */
  byMessage: Map<string, TokenUsage>;
  totals: TokenUsage;
}

/**
 * Stateful parser for Claude Code transcript lines (`~/.claude/projects/**\/*.jsonl`).
 * Emits token usage for every session, and state events that the store only uses for
 * sessions without hooks (ADR-001). Prompt text is never read beyond its type.
 */
export class TranscriptParser {
  readonly #usage = new Map<string, SessionUsage>();
  /** Open Task/Agent tool_use ids per session, to match their tool_result. */
  readonly #pendingSubagents = new Map<string, Set<string>>();

  parse(line: string, fallbackSessionId: string): SessionEvent[] {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(entry)) return [];
    const type = str(entry.type);
    const message = obj(entry.message);
    if ((type !== 'user' && type !== 'assistant') || !message) return [];

    const sessionId = str(entry.sessionId) ?? fallbackSessionId;
    const cwd = str(entry.cwd);
    const at = Date.parse(str(entry.timestamp) ?? '') || Date.now();
    const base = { sessionId, at, ...(cwd ? { cwd } : {}) };
    // Subagent (sidechain) lines count towards tokens but don't drive the chef's state.
    const sidechain = entry.isSidechain === true;
    const events: SessionEvent[] = [];

    if (type === 'assistant') {
      const tokens = this.#addUsage(sessionId, message);
      if (tokens) events.push({ ...base, type: 'usage', tokens });
      if (sidechain) return events;

      const toolUses = blocks(message.content).filter((b) => b.type === 'tool_use');
      for (const block of toolUses) {
        const tool = str(block.name) ?? 'tool';
        const input = obj(block.input);
        const id = str(block.id);
        const subagent =
          isSubagentTool(tool) && id ? { id, type: str(input?.subagent_type) } : undefined;
        if (subagent) this.#pending(sessionId).add(subagent.id);
        events.push({
          ...base,
          type: 'tool.start',
          tool,
          target: toolTarget(input, cwd),
          ...(subagent ? { subagent } : {}),
        });
      }
      const stopReason = str(message.stop_reason);
      if (toolUses.length === 0 && (stopReason === 'end_turn' || stopReason === 'stop_sequence')) {
        events.push({ ...base, type: 'stop' });
      }
      return events;
    }

    // type === 'user'
    if (sidechain || entry.isMeta === true) return events;
    const content = message.content;
    if (typeof content === 'string') {
      if (!isLocalCommand(content)) events.push({ ...base, type: 'prompt' });
      return events;
    }
    const results = blocks(content).filter((b) => b.type === 'tool_result');
    if (results.length === 0) {
      events.push({ ...base, type: 'prompt' });
      return events;
    }
    for (const result of results) {
      const id = str(result.tool_use_id);
      const pending = this.#pending(sessionId);
      const subagentId = id && pending.delete(id) ? id : undefined;
      events.push({ ...base, type: 'tool.end', ...(subagentId ? { subagentId } : {}) });
    }
    return events;
  }

  #addUsage(sessionId: string, message: Json): TokenUsage | null {
    const usage = obj(message.usage);
    const messageId = str(message.id);
    if (!usage || !messageId) return null;

    let session = this.#usage.get(sessionId);
    if (!session) {
      session = {
        byMessage: new Map(),
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      this.#usage.set(sessionId, session);
    }
    const next: TokenUsage = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
    const prev = session.byMessage.get(messageId);
    session.byMessage.set(messageId, next);
    const t = session.totals;
    session.totals = {
      input: t.input + next.input - (prev?.input ?? 0),
      output: t.output + next.output - (prev?.output ?? 0),
      cacheRead: t.cacheRead + next.cacheRead - (prev?.cacheRead ?? 0),
      cacheWrite: t.cacheWrite + next.cacheWrite - (prev?.cacheWrite ?? 0),
    };
    return session.totals;
  }

  #pending(sessionId: string): Set<string> {
    let set = this.#pendingSubagents.get(sessionId);
    if (!set) {
      set = new Set();
      this.#pendingSubagents.set(sessionId, set);
    }
    return set;
  }
}

export interface TranscriptTailOptions {
  projectsDir: string;
  onEvent: (event: SessionEvent) => void;
  /** At startup, only files modified this recently are read. Default: 1 hour. */
  recentMs?: number;
  /** Retry delay while `projectsDir` doesn't exist yet. Default: 5 s. */
  retryMs?: number;
}

interface TailedFile {
  offset: number;
  rest: string;
  decoder: StringDecoder;
  sessionId: string;
  reading: Promise<void> | null;
  again: boolean;
}

/**
 * Follows transcript files: reads recent ones at startup, then reads appended lines as
 * files change. Files first seen after startup are read from the beginning.
 */
export class TranscriptTail {
  readonly #options: Required<TranscriptTailOptions>;
  readonly #parser = new TranscriptParser();
  readonly #files = new Map<string, TailedFile>();
  #watcher: FSWatcher | null = null;
  #retry: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(options: TranscriptTailOptions) {
    this.#options = { recentMs: 60 * 60_000, retryMs: 5_000, ...options };
  }

  async start(): Promise<void> {
    if (this.#stopped) return;
    const { projectsDir, recentMs, retryMs } = this.#options;
    try {
      // Watch before scanning so nothing written during the scan is missed.
      this.#watcher = watch(projectsDir, { recursive: true }, (_event, name) => {
        if (name && name.toString().endsWith('.jsonl')) {
          void this.#read(path.join(projectsDir, name.toString()));
        }
      });
      this.#watcher.on('error', () => this.#restart());
    } catch {
      this.#retry = setTimeout(() => void this.start(), retryMs);
      this.#retry.unref();
      return;
    }

    const cutoff = Date.now() - recentMs;
    for (const file of await listJsonl(projectsDir)) {
      if (this.#stopped) return;
      const info = await stat(file).catch(() => null);
      if (info && info.mtimeMs >= cutoff) await this.#read(file);
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#retry) clearTimeout(this.#retry);
  }

  /** Resolves once the file has been read up to its current end. */
  #read(file: string): Promise<void> {
    let tailed = this.#files.get(file);
    if (!tailed) {
      tailed = {
        offset: 0,
        rest: '',
        decoder: new StringDecoder('utf8'),
        sessionId: path.basename(file, '.jsonl'),
        reading: null,
        again: false,
      };
      this.#files.set(file, tailed);
    }
    const t = tailed;
    if (t.reading) {
      t.again = true;
      return t.reading;
    }
    t.reading = (async () => {
      do {
        t.again = false;
        await this.#drain(file, t);
      } while (t.again && !this.#stopped);
    })().finally(() => {
      t.reading = null;
    });
    return t.reading;
  }

  async #drain(file: string, t: TailedFile): Promise<void> {
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (size < t.offset) {
        // Truncated or replaced: start over.
        t.offset = 0;
        t.rest = '';
        t.decoder = new StringDecoder('utf8');
      }
      const chunk = Buffer.alloc(Math.min(Math.max(size - t.offset, 0), 1 << 20));
      while (t.offset < size && !this.#stopped) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - t.offset),
          t.offset,
        );
        if (bytesRead === 0) break;
        t.offset += bytesRead;
        const lines = (t.rest + t.decoder.write(chunk.subarray(0, bytesRead))).split('\n');
        t.rest = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.#emit(this.#parser.parse(line, t.sessionId));
        }
      }
    } finally {
      await handle.close();
    }
  }

  #emit(events: SessionEvent[]): void {
    for (const event of events) {
      try {
        this.#options.onEvent(event);
      } catch {
        // Keep tailing even if a consumer throws.
      }
    }
  }

  #restart(): void {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#stopped) return;
    this.#retry = setTimeout(() => void this.start(), this.#options.retryMs);
    this.#retry.unref();
  }
}

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
}

function blocks(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

/** Slash-command echoes and their output are written as user lines; they aren't prompts. */
function isLocalCommand(content: string): boolean {
  return /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr)>/.test(
    content,
  );
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
