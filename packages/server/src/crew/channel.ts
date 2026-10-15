import {
  CREW_COMMAND_TYPES,
  parseCrewCommand,
  type CrewCommandReply,
  type CrewCommandType,
} from 'orderup-shared';
import { crewError, dispatchCrewCommand, type CrewController } from './controller.js';
import { tokenMatches } from './token.js';

/** Crew commands accepted per connection per second; more get `rate_limited`. */
export const CREW_RATE_LIMIT = 10;
const RATE_WINDOW_MS = 1000;

export interface CrewChannelOptions {
  /** The command token, or `null` when the server runs without `--crew`. */
  token: string | null;
  controller: CrewController;
  now?: () => number;
}

/** Whether a client message is a crew command (`type` is one of the five), valid or not. */
export function isCrewCommandMessage(message: Record<string, unknown>): boolean {
  return (CREW_COMMAND_TYPES as readonly unknown[]).includes(message.type);
}

/**
 * The command channel of one WebSocket connection (ADR-015). The connection already passed the
 * Host/Origin checks at upgrade (ADR-003). Each command then must be within the rate limit,
 * carry the token (constant-time compare) and pass `parseCrewCommand`, in that order, before
 * it reaches the controller. Without `--crew` every command gets `crew_disabled`.
 */
export function createCrewChannel({
  token,
  controller,
  now = Date.now,
}: CrewChannelOptions): (message: Record<string, unknown>) => Promise<CrewCommandReply> {
  const recent: number[] = [];

  return async (message) => {
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';
    const type = message.type as CrewCommandType;
    const fail = (code: Parameters<typeof crewError>[2], text: string) =>
      crewError(requestId, type, code, text);

    if (token === null) return fail('crew_disabled', 'crew is off: start orderup with --crew');

    const t = now();
    while (recent.length && t - recent[0]! >= RATE_WINDOW_MS) recent.shift();
    if (recent.length >= CREW_RATE_LIMIT) {
      return fail('rate_limited', `at most ${CREW_RATE_LIMIT} crew commands per second`);
    }
    recent.push(t);

    // Before parsing, so an unauthenticated client learns nothing about the command shape.
    if (!tokenMatches(token, message.token)) return fail('unauthorized', 'missing or wrong token');

    const parsed = parseCrewCommand(message);
    if (!parsed.ok) return crewError(requestId, parsed.command, parsed.code, parsed.message);

    try {
      return await dispatchCrewCommand(controller, parsed.command);
    } catch {
      return fail('busy', 'the crew could not take the command');
    }
  };
}
