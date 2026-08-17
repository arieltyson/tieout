/**
 * The run state machine.
 *
 * A close is not a function call. It runs for minutes, stops to ask a human
 * something, and then waits however long that human takes. The states below
 * are the only ones a run may be in, and the transition function is the
 * only way it may move between them.
 *
 * Written as a pure function so the whole space can be enumerated in tests.
 * Seven states and six events is forty two combinations, which is small
 * enough to check exhaustively, so it is checked exhaustively. Every
 * illegal transition asserted against is a class of bug that cannot reach
 * production.
 */
import type { RunState } from '../domain/close-run.js';

export type RunEvent =
  | { type: 'dispatch' }
  | { type: 'agentsComplete' }
  | { type: 'verified'; hasBlockingFailure: boolean }
  | { type: 'decisionsReceived' }
  | { type: 'applied' }
  | { type: 'failed'; reason: string };

export class InvalidTransition extends Error {
  constructor(
    readonly from: RunState,
    readonly event: RunEvent['type'],
  ) {
    super(`A run in "${from}" cannot handle "${event}".`);
    this.name = 'InvalidTransition';
  }
}

/**
 * The only legal moves.
 *
 * `failed` is reachable from every live state, because anything can break.
 * Nothing is reachable FROM `complete` or `failed`: those are terminal, and
 * a run that can resurrect itself is a run whose history cannot be trusted.
 */
export function transition(from: RunState, event: RunEvent): RunState {
  if (event.type === 'failed') {
    if (from === 'complete' || from === 'failed') throw new InvalidTransition(from, event.type);
    return 'failed';
  }

  switch (from) {
    case 'planning':
      if (event.type === 'dispatch') return 'dispatched';
      break;
    case 'dispatched':
      if (event.type === 'agentsComplete') return 'verifying';
      break;
    case 'verifying':
      if (event.type === 'verified') {
        // A blocking failure sends the run back to the agents to repair
        // rather than to a human to rubber stamp.
        return event.hasBlockingFailure ? 'dispatched' : 'awaitingApproval';
      }
      break;
    case 'awaitingApproval':
      if (event.type === 'decisionsReceived') return 'applying';
      break;
    case 'applying':
      if (event.type === 'applied') return 'complete';
      break;
    case 'complete':
    case 'failed':
      break;
  }
  throw new InvalidTransition(from, event.type);
}

export const ALL_STATES: readonly RunState[] = [
  'planning',
  'dispatched',
  'verifying',
  'awaitingApproval',
  'applying',
  'complete',
  'failed',
];

export const ALL_EVENT_TYPES: readonly RunEvent['type'][] = [
  'dispatch',
  'agentsComplete',
  'verified',
  'decisionsReceived',
  'applied',
  'failed',
];

export function isTerminal(state: RunState): boolean {
  return state === 'complete' || state === 'failed';
}

/** True when the run is parked waiting on a person rather than on work. */
export function isWaitingOnHuman(state: RunState): boolean {
  return state === 'awaitingApproval';
}
