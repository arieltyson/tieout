import { describe, expect, test } from 'vitest';
import type { RunState } from '../src/domain/close-run.js';
import {
  ALL_EVENT_TYPES, ALL_STATES, InvalidTransition, isTerminal, isWaitingOnHuman,
  transition, type RunEvent,
} from '../src/store/run-state.js';

const event = (type: RunEvent['type']): RunEvent =>
  type === 'verified' ? { type, hasBlockingFailure: false }
  : type === 'failed' ? { type, reason: 'x' }
  : ({ type } as RunEvent);

/** Every legal move, written out. Anything absent here must throw. */
const LEGAL: readonly { from: RunState; type: RunEvent['type']; to: RunState }[] = [
  { from: 'planning', type: 'dispatch', to: 'dispatched' },
  { from: 'dispatched', type: 'agentsComplete', to: 'verifying' },
  { from: 'verifying', type: 'verified', to: 'awaitingApproval' },
  { from: 'awaitingApproval', type: 'decisionsReceived', to: 'applying' },
  { from: 'applying', type: 'applied', to: 'complete' },
  { from: 'planning', type: 'failed', to: 'failed' },
  { from: 'dispatched', type: 'failed', to: 'failed' },
  { from: 'verifying', type: 'failed', to: 'failed' },
  { from: 'awaitingApproval', type: 'failed', to: 'failed' },
  { from: 'applying', type: 'failed', to: 'failed' },
];

describe('the happy path', () => {
  test('planning through to complete', () => {
    let s: RunState = 'planning';
    s = transition(s, { type: 'dispatch' });
    s = transition(s, { type: 'agentsComplete' });
    s = transition(s, { type: 'verified', hasBlockingFailure: false });
    expect(s).toBe('awaitingApproval');
    s = transition(s, { type: 'decisionsReceived' });
    s = transition(s, { type: 'applied' });
    expect(s).toBe('complete');
  });

  test('a blocking failure returns to the agents, not to a human', () => {
    // The whole point of the bank: a rejected batch gets repaired rather
    // than presented for approval.
    expect(transition('verifying', { type: 'verified', hasBlockingFailure: true }))
      .toBe('dispatched');
  });
});

// Seven states by six events is forty two combinations. Small enough to
// enumerate, so enumerated: every pair not in LEGAL must throw.
describe('the full transition matrix', () => {
  const legalKey = new Set(LEGAL.map((l) => `${l.from}:${l.type}`));

  for (const from of ALL_STATES) {
    for (const type of ALL_EVENT_TYPES) {
      const key = `${from}:${type}`;
      if (legalKey.has(key)) {
        const expected = LEGAL.find((l) => `${l.from}:${l.type}` === key)!.to;
        test(`${from} + ${type} -> ${expected}`, () => {
          expect(transition(from, event(type))).toBe(expected);
        });
      } else {
        test(`${from} + ${type} is rejected`, () => {
          expect(() => transition(from, event(type))).toThrow(InvalidTransition);
        });
      }
    }
  }
});

describe('terminal states are terminal', () => {
  test('nothing escapes complete', () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(() => transition('complete', event(type))).toThrow(InvalidTransition);
    }
  });

  test('nothing escapes failed, including another failure', () => {
    // A run that can resurrect itself has a history nobody can trust.
    for (const type of ALL_EVENT_TYPES) {
      expect(() => transition('failed', event(type))).toThrow(InvalidTransition);
    }
  });

  test('isTerminal agrees with the transition function', () => {
    for (const s of ALL_STATES) {
      const escapable = ALL_EVENT_TYPES.some(() => {
        try { transition(s, { type: 'failed', reason: 'x' }); return true; } catch { return false; }
      });
      expect(isTerminal(s)).toBe(!escapable);
    }
  });
});

describe('failure is reachable from every live state', () => {
  test.each(['planning', 'dispatched', 'verifying', 'awaitingApproval', 'applying'] as RunState[])(
    '%s can fail',
    (from) => {
      expect(transition(from, { type: 'failed', reason: 'boom' })).toBe('failed');
    },
  );
});

describe('helpers', () => {
  test('only awaitingApproval is waiting on a person', () => {
    const waiting = ALL_STATES.filter(isWaitingOnHuman);
    expect(waiting).toEqual(['awaitingApproval']);
  });

  test('the error names the state and the event', () => {
    try {
      transition('complete', { type: 'dispatch' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('complete');
      expect((err as Error).message).toContain('dispatch');
    }
  });
});
