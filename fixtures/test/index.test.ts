import { describe, expect, test } from 'vitest';
import { DEFAULT_PERIOD, DEFAULT_SEED, generateFixture, loadGroundTruth, loadLedger } from '../src/index.js';

describe('loadLedger / loadGroundTruth', () => {
  test('the committed fixture files are valid and match the generator for the default seed', () => {
    const { ledger, groundTruth } = generateFixture(DEFAULT_SEED, DEFAULT_PERIOD);
    expect(loadLedger()).toEqual(ledger);
    expect(loadGroundTruth()).toEqual(groundTruth);
  });
});
