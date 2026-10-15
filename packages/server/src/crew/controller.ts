import type {
  CrewAck,
  CrewCommand,
  CrewCommandType,
  CrewError,
  CrewErrorCode,
} from 'orderup-shared';

/** A crew command as the controller sees it: validated, authorized, and without its token. */
export type CrewRequest<T extends CrewCommandType = CrewCommandType> = T extends CrewCommandType
  ? Omit<Extract<CrewCommand, { type: T }>, 'token'>
  : never;

/** The typed reply to one command: its own `ack`, or an `error`. */
export type CrewResult<T extends CrewCommandType> = Extract<CrewAck, { command: T }> | CrewError;

/**
 * What the command channel hands authorized commands to (ADR-015, ADR-016 point 6). Every
 * command already passed the Host/Origin checks, the token and `parseCrewCommand`. The crew
 * runner (#19) implements it; until then the server uses `DisabledCrewController`.
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

/** Answers every command with `crew_disabled`: the runner is not wired yet (#19). */
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
