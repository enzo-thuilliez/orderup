import { execFile } from 'node:child_process';
import type { CrewEvent, Ticket, TicketSourceStatus } from 'orderup-shared';

/** The `crew.tickets` event: the source's whole state, sent as is to clients. */
export type TicketsMessage = Extract<CrewEvent, { type: 'crew.tickets' }>;

/**
 * Runs a program without a shell. Resolves with its stdout, or rejects like `execFile`: an
 * error with `code` (`'ENOENT'` when missing, else the exit code), `killed`, `signal` and
 * `stderr`.
 */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export interface TicketSourceOptions {
  /** GitHub repos as "owner/name": one brigade per working repo (ADR-016). */
  repos: readonly string[];
  /** Poll interval. Default 60 s. */
  intervalMs?: number;
  /** Per `gh` call. Default 15 s. */
  timeoutMs?: number;
  /** Called after a poll that changed the tickets, status or message. */
  onChange?: (message: TicketsMessage) => void;
  /** Gets one line per status change. Default `console.warn`. */
  log?: (line: string) => void;
  /** Injected in tests. Default: `execFile` on `gh`. */
  exec?: ExecFn;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 10 * 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const FIELDS = 'number,title,labels,url,updatedAt';
/** gh's default is 30; more than this many open issues per repo are not shown. */
const ISSUE_LIMIT = 100;

/** "owner/name", and never an option gh could parse (`-`). */
export function isValidRepo(repo: string): boolean {
  return REPO_RE.test(repo) && !repo.startsWith('-');
}

/** `execFile` with no shell. The environment is inherited for `gh`'s auth and never logged. */
export const execGh: ExecFn = (file, args, { timeout, maxBuffer }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout,
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else resolve({ stdout });
      },
    );
  });

class Failure extends Error {
  constructor(
    readonly status: Exclude<TicketSourceStatus, 'ok'>,
    message: string,
  ) {
    super(message);
  }
}

/** Maps an `execFile` rejection to a status. Never echoes stderr: only fixed, short messages. */
function classify(err: unknown, repo: string, timeoutMs: number): Failure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  if (e.code === 'ENOENT') return new Failure('gh-missing', 'gh is not installed or not on PATH');
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  // gh exits with 4 when authentication is required.
  if (e.code === 4 || /gh auth login|not logged in/i.test(stderr)) {
    return new Failure('unauthenticated', 'gh is not logged in: run `gh auth login`');
  }
  if (e.killed === true || typeof e.signal === 'string') {
    return new Failure('error', `gh timed out after ${Math.round(timeoutMs / 1000)} s (${repo})`);
  }
  const exit = typeof e.code === 'number' ? ` (exit ${e.code})` : '';
  return new Failure('error', `gh issue list failed for ${repo}${exit}`);
}

/** Maps `gh issue list --json` output to tickets, most recently updated first. */
export function parseIssueList(stdout: string, repo: string): Ticket[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Failure('error', `gh returned invalid JSON for ${repo}`);
  }
  if (!Array.isArray(data)) throw new Failure('error', `gh returned unexpected JSON for ${repo}`);

  const rows: { ticket: Ticket; updatedAt: number }[] = [];
  for (const item of data as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { number, title, url, labels, updatedAt } = item as Record<string, unknown>;
    if (!Number.isSafeInteger(number) || (number as number) < 1) continue;
    if (typeof title !== 'string' || typeof url !== 'string') continue;
    const names = Array.isArray(labels)
      ? labels
          .map((l: unknown) =>
            typeof l === 'object' && l !== null ? (l as { name?: unknown }).name : undefined,
          )
          .filter((n): n is string => typeof n === 'string')
      : [];
    const at = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
    rows.push({
      ticket: { repo, number: number as number, title, labels: names, url },
      updatedAt: Number.isNaN(at) ? 0 : at,
    });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).map((r) => r.ticket);
}

/**
 * Polls `gh issue list` for each repo and keeps the open issues in memory as order tickets.
 * On failure it keeps each repo's last good list and reports a status; it never throws.
 * Crew only (V1): the observer path never starts it.
 */
export class TicketSource {
  readonly #repos: string[];
  /** Skipped, never passed to gh; reported as an `error` status. */
  readonly #invalid: string[];
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #exec: ExecFn;
  readonly #log: (line: string) => void;
  readonly #onChange: ((message: TicketsMessage) => void) | undefined;

  readonly #byRepo = new Map<string, Ticket[]>();
  #status: TicketSourceStatus = 'ok';
  #message: string | null = null;
  #updatedAt: number | null = null;
  #inFlight: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  /** Bumped by start/stop so a poll that ends after stop() schedules nothing. */
  #generation = 0;
  #running = false;

  constructor(options: TicketSourceOptions) {
    const repos = [...new Set(options.repos)];
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (!(intervalMs > 0)) throw new TypeError('intervalMs must be positive');

    this.#repos = repos.filter(isValidRepo);
    this.#invalid = repos.filter((r) => !isValidRepo(r));
    this.#intervalMs = intervalMs;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = options.exec ?? execGh;
    this.#log = options.log ?? ((line) => console.warn(line));
    this.#onChange = options.onChange;
  }

  get status(): TicketSourceStatus {
    return this.#status;
  }

  /** Open issues of every repo, in repo order. */
  get tickets(): Ticket[] {
    return this.#repos.flatMap((r) => this.#byRepo.get(r) ?? []);
  }

  snapshot(): TicketsMessage {
    return {
      type: 'crew.tickets',
      tickets: this.tickets,
      status: this.#status,
      message: this.#message,
      updatedAt: this.#updatedAt,
    };
  }

  /** Polls now, then every interval. Polls never overlap: the next one is timed from the end of the last. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const generation = ++this.#generation;
    void this.#loop(generation);
  }

  stop(): void {
    this.#running = false;
    this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** One poll of every repo. Joins the poll in flight, if any. */
  poll(): Promise<void> {
    this.#inFlight ??= this.#pollAll().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #loop(generation: number): Promise<void> {
    await this.poll();
    if (generation !== this.#generation) return;
    this.#timer = setTimeout(() => void this.#loop(generation), this.#intervalMs);
    this.#timer.unref();
  }

  async #pollAll(): Promise<void> {
    const before = JSON.stringify(this.snapshot());
    let failure: Failure | null = null;

    for (const repo of this.#repos) {
      try {
        const { stdout } = await this.#exec(
          'gh',
          [
            'issue',
            'list',
            '--repo',
            repo,
            '--state',
            'open',
            '--json',
            FIELDS,
            '--limit',
            String(ISSUE_LIMIT),
          ],
          { timeout: this.#timeoutMs, maxBuffer: MAX_BUFFER },
        );
        this.#byRepo.set(repo, parseIssueList(stdout, repo));
      } catch (err) {
        failure ??= err instanceof Failure ? err : classify(err, repo, this.#timeoutMs);
        // Every other repo would fail the same way.
        if (failure.status !== 'error') break;
      }
    }

    // A gh failure is more actionable, so it wins over a bad repo.
    const bad = this.#invalid[0];
    if (!failure && bad !== undefined) {
      failure = new Failure('error', `invalid repo "${bad.slice(0, 100)}", expected "owner/name"`);
    }
    if (!failure) this.#updatedAt = Date.now();
    this.#setStatus(failure?.status ?? 'ok', failure?.message ?? null);

    const after = this.snapshot();
    if (JSON.stringify(after) !== before) this.#onChange?.(after);
  }

  #setStatus(status: TicketSourceStatus, message: string | null): void {
    const changed = status !== this.#status;
    this.#status = status;
    this.#message = message;
    if (!changed) return;
    this.#log(
      status === 'ok'
        ? 'orderup: GitHub tickets are back'
        : `orderup: GitHub tickets unavailable (${status}): ${message}`,
    );
  }
}
