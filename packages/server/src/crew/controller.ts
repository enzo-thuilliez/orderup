import { randomBytes } from 'node:crypto';
import type {
  CrewAck,
  CrewCommand,
  CrewCommandType,
  CrewError,
  CrewErrorCode,
  TicketRef,
} from 'orderup-shared';
import type { Repository } from '../persistence/index.js';
import type { CrewRunner, StartRunOptions, StartRunRefusal } from './runner.js';

/** A crew command as the controller sees it: validated, authorized, and without its token. */
export type CrewRequest<T extends CrewCommandType = CrewCommandType> = T extends CrewCommandType
  ? Omit<Extract<CrewCommand, { type: T }>, 'token'>
  : never;

/** The typed reply to one command: its own `ack`, or an `error`. */
export type CrewResult<T extends CrewCommandType> = Extract<CrewAck, { command: T }> | CrewError;

/**
 * What the command channel hands authorized commands to (ADR-015, ADR-016 point 6). Every
 * command already passed the Host/Origin checks, the token and `parseCrewCommand`. With
 * `--crew` the server uses `RunnerCrewController`; without it, `DisabledCrewController`.
 */
export interface CrewController {
  talk(request: CrewRequest<'talk'>): Promise<CrewResult<'talk'>>;
  assign(request: CrewRequest<'assign'>): Promise<CrewResult<'assign'>>;
  stop(request: CrewRequest<'stop'>): Promise<CrewResult<'stop'>>;
  approve(request: CrewRequest<'approve'>): Promise<CrewResult<'approve'>>;
  sendBack(request: CrewRequest<'send-back'>): Promise<CrewResult<'send-back'>>;
}

export function crewError(
  requestId: string,
  command: CrewCommandType | null,
  code: CrewErrorCode,
  message: string,
): CrewError {
  return { type: 'error', requestId, command, code, message };
}

/** Answers every command with `crew_disabled`: the server runs without `--crew`. */
export class DisabledCrewController implements CrewController {
  private disabled(request: CrewRequest): Promise<CrewError> {
    return Promise.resolve(
      crewError(
        request.requestId,
        request.type,
        'crew_disabled',
        'the crew runner is not available yet',
      ),
    );
  }
  talk(request: CrewRequest<'talk'>) {
    return this.disabled(request);
  }
  assign(request: CrewRequest<'assign'>) {
    return this.disabled(request);
  }
  stop(request: CrewRequest<'stop'>) {
    return this.disabled(request);
  }
  approve(request: CrewRequest<'approve'>) {
    return this.disabled(request);
  }
  sendBack(request: CrewRequest<'send-back'>) {
    return this.disabled(request);
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `t_` + a ULID-style id: 10 Crockford base32 characters of epoch ms, then 16 random ones.
 * Sorts by creation time and passes `isValidTaskId`.
 */
export function newTaskId(now: number = Date.now()): string {
  let time = '';
  for (let t = Math.max(0, Math.floor(now)), i = 0; i < 10; i++, t = Math.floor(t / 32)) {
    time = CROCKFORD[t % 32]! + time;
  }
  let random = '';
  for (const byte of randomBytes(16)) random += CROCKFORD[byte % 32]!;
  return `t_${time}${random}`;
}

/** The stdin prompt of an `assign`: the ticket ref only. The chef reads the issue itself. */
export function assignPrompt(ticket: TicketRef): string {
  const ref = `${ticket.repo}#${ticket.number}`;
  return (
    `Work on the GitHub issue ${ref}.\n` +
    `Read it first with \`gh issue view ${ticket.number} --repo ${ticket.repo} --comments\`, ` +
    `then do what it asks and open a pull request that closes ${ref}.\n`
  );
}

const REFUSAL_CODES: Record<StartRunRefusal, CrewErrorCode> = {
  busy: 'busy',
  usage_cap_reached: 'usage_cap_reached',
  no_repo: 'invalid_command',
  invalid: 'invalid_command',
  setup_failed: 'invalid_command',
};

/**
 * Drives the crew runner from the command channel (#20, ADR-016 point 6). Every command goes
 * to the head chef. Each `talk` and `assign` is a new task with its own id; a `talk` continues
 * the chef conversation of the latest `talk`. Report cards are not stored yet (#31), so
 * `approve` and `send-back` know no card.
 */
export class RunnerCrewController implements CrewController {
  private readonly now: () => number;
  /** Chef sessions a `talk` is resuming while its run is still starting. */
  private readonly resuming = new Set<string>();

  constructor(
    private readonly runner: CrewRunner,
    private readonly repository: Repository,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async talk(request: CrewRequest<'talk'>): Promise<CrewResult<'talk'>> {
    const taskId = newTaskId(this.now());
    const resumeSessionId = this.talkSession();
    // The run row only exists once startRun returns: hold the session until then.
    if (resumeSessionId) this.resuming.add(resumeSessionId);
    let started;
    try {
      started = await this.start(request, {
        trigger: 'talk',
        taskId,
        prompt: request.text,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
    } finally {
      if (resumeSessionId) this.resuming.delete(resumeSessionId);
    }
    if (!started.ok) return started.error;
    return { type: 'ack', requestId: request.requestId, command: 'talk', runId: started.runId };
  }

  async assign(request: CrewRequest<'assign'>): Promise<CrewResult<'assign'>> {
    const taskId = newTaskId(this.now());
    const started = await this.start(request, {
      trigger: 'assign',
      taskId,
      prompt: assignPrompt(request.ticket),
    });
    if (!started.ok) return started.error;
    // One card per task (#31): the card id is the task id.
    return {
      type: 'ack',
      requestId: request.requestId,
      command: 'assign',
      runId: started.runId,
      cardId: taskId,
    };
  }

  /** Stops the most recently started run that is still active. */
  async stop(request: CrewRequest<'stop'>): Promise<CrewResult<'stop'>> {
    const runId = this.runner.activeRunIds.at(-1) ?? null;
    const stopped = runId !== null && (await this.runner.stop(runId));
    return {
      type: 'ack',
      requestId: request.requestId,
      command: 'stop',
      runId: stopped ? runId : null,
    };
  }

  approve(request: CrewRequest<'approve'>): Promise<CrewResult<'approve'>> {
    return Promise.resolve(this.unknownCard(request));
  }

  sendBack(request: CrewRequest<'send-back'>): Promise<CrewResult<'send-back'>> {
    return Promise.resolve(this.unknownCard(request));
  }

  /**
   * The chef session of the latest `talk`, unless a running chef is in it: two processes must
   * never write the same session, so a `talk` during another one starts a fresh conversation.
   */
  private talkSession(): string | undefined {
    const sessionId = this.repository.latestRunWithSession('talk')?.chefSessionId;
    if (!sessionId) return undefined;
    const inUse =
      this.resuming.has(sessionId) ||
      this.runner.activeRunIds.some(
        (id) => this.repository.getRun(id)?.chefSessionId === sessionId,
      );
    return inUse ? undefined : sessionId;
  }

  private async start(
    request: CrewRequest,
    options: StartRunOptions,
  ): Promise<{ ok: true; runId: string } | { ok: false; error: CrewError }> {
    const result = await this.runner.startRun(options);
    if (result.ok) return result;
    return {
      ok: false,
      error: crewError(request.requestId, request.type, REFUSAL_CODES[result.code], result.message),
    };
  }

  private unknownCard(request: CrewRequest<'approve' | 'send-back'>): CrewError {
    return crewError(request.requestId, request.type, 'unknown_card', 'no such report card');
  }
}

/** Routes one authorized command to its controller method. The token never reaches it. */
export function dispatchCrewCommand(
  controller: CrewController,
  command: CrewCommand,
): Promise<CrewAck | CrewError> {
  switch (command.type) {
    case 'talk': {
      const { token: _token, ...request } = command;
      return controller.talk(request);
    }
    case 'assign': {
      const { token: _token, ...request } = command;
      return controller.assign(request);
    }
    case 'stop': {
      const { token: _token, ...request } = command;
      return controller.stop(request);
    }
    case 'approve': {
      const { token: _token, ...request } = command;
      return controller.approve(request);
    }
    case 'send-back': {
      const { token: _token, ...request } = command;
      return controller.sendBack(request);
    }
  }
}
