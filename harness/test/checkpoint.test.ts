import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CheckpointStore, UnknownRun } from '../src/store/checkpoint.js';
import { InvalidTransition } from '../src/store/run-state.js';
import * as f from './support/proposals.js';

let store: CheckpointStore;
let dir: string;

beforeEach(() => { f.resetProposalIds(); store = new CheckpointStore(':memory:'); });
afterEach(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

const toApproval = (runId: string) => {
  store.advance(runId, { type: 'dispatch' });
  store.advance(runId, { type: 'agentsComplete' });
  store.advance(runId, { type: 'verified', hasBlockingFailure: false });
};

describe('checkpointing', () => {
  test('a new run starts in planning', () => {
    expect(store.create('r1', '2026-06').state).toBe('planning');
  });

  test('an unknown run throws rather than returning an empty shell', () => {
    expect(() => store.load('nope')).toThrow(UnknownRun);
  });

  test('state survives being written and read back', () => {
    store.create('r1', '2026-06');
    toApproval('r1');
    expect(store.load('r1').state).toBe('awaitingApproval');
  });

  test('proposals survive the round trip', () => {
    store.create('r1', '2026-06');
    const proposals = f.validCategorizations();
    store.saveProposals('r1', proposals);
    expect(store.load('r1').proposals).toEqual(proposals);
  });

  test('an illegal transition never reaches disk', () => {
    // A checkpoint recording an impossible state is worse than none,
    // because resume will trust it.
    store.create('r1', '2026-06');
    expect(() => store.advance('r1', { type: 'applied' })).toThrow(InvalidTransition);
    expect(store.load('r1').state).toBe('planning');
  });

  test('history records every move in order', () => {
    store.create('r1', '2026-06');
    toApproval('r1');
    expect(store.history('r1').map((h) => h.state)).toEqual([
      'planning', 'dispatched', 'verifying', 'awaitingApproval',
    ]);
  });
});

describe('surviving a restart', () => {
  test('a run parked for approval is found again by a fresh process', () => {
    dir = mkdtempSync(join(tmpdir(), 'tieout-ckpt-'));
    const path = join(dir, 'runs.db');

    const first = new CheckpointStore(path);
    first.create('r1', '2026-06');
    first.saveProposals('r1', f.validCategorizations());
    first.advance('r1', { type: 'dispatch' });
    first.advance('r1', { type: 'agentsComplete' });
    first.advance('r1', { type: 'verified', hasBlockingFailure: false });
    first.close();

    // Nothing in memory, no timer, no open handle. A different process.
    const second = new CheckpointStore(path);
    try {
      const parked = second.awaitingApproval();
      expect(parked.map((p) => p.runId)).toEqual(['r1']);
      expect(parked[0]!.proposals).toHaveLength(3);
      // And it can carry on from exactly where it stopped.
      expect(second.advance('r1', { type: 'decisionsReceived' }).state).toBe('applying');
    } finally {
      second.close();
    }
  });

  test('only parked runs are offered for resumption', () => {
    store.create('r1', '2026-06');
    store.create('r2', '2026-06');
    toApproval('r1');
    expect(store.awaitingApproval().map((c) => c.runId)).toEqual(['r1']);
  });
});

describe('applying a decision is idempotent', () => {
  const decision = { idempotencyKey: 'categorize:txn_0001:6010', proposalId: 'prop_0001',
    kind: 'approved' as const, decidedBy: 'human' };

  test('the first application takes effect', () => {
    store.create('r1', '2026-06');
    expect(store.applyDecision('r1', decision)).toBe(true);
    expect(store.decisions('r1')).toHaveLength(1);
  });

  test('applying the same decision three times has one effect', () => {
    // Somebody will double tap approve.
    store.create('r1', '2026-06');
    expect(store.applyDecision('r1', decision)).toBe(true);
    expect(store.applyDecision('r1', decision)).toBe(false);
    expect(store.applyDecision('r1', decision)).toBe(false);
    expect(store.decisions('r1')).toHaveLength(1);
  });

  test('a later contradictory decision on the same key does not overwrite', () => {
    // The key identifies the decision, so a reject arriving after an
    // approve on the same key is a duplicate delivery, not a reversal.
    store.create('r1', '2026-06');
    store.applyDecision('r1', decision);
    store.applyDecision('r1', { ...decision, kind: 'rejected' });
    expect(store.decisions('r1')[0]!.kind).toBe('approved');
  });

  test('different proposals decide independently', () => {
    store.create('r1', '2026-06');
    store.applyDecision('r1', decision);
    store.applyDecision('r1', { ...decision, idempotencyKey: 'other', proposalId: 'prop_0002' });
    expect(store.decisions('r1')).toHaveLength(2);
  });
});

describe('what a resumed run still needs', () => {
  test('undecided proposals shrink as decisions arrive', () => {
    store.create('r1', '2026-06');
    const proposals = f.validCategorizations();
    store.saveProposals('r1', proposals);
    expect(store.undecided('r1')).toHaveLength(3);

    store.applyDecision('r1', {
      idempotencyKey: proposals[0]!.idempotencyKey, proposalId: proposals[0]!.id,
      kind: 'approved', decidedBy: 'human',
    });
    expect(store.undecided('r1')).toHaveLength(2);
  });
});
